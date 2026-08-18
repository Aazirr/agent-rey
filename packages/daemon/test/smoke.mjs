/**
 * End-to-end smoke test against a real reyd process.
 *
 * Covers the security-critical path first: wrong password rejected, throttle
 * engages, unauthenticated socket refused, then the happy path through
 * hello → projects.list → sessions.list.
 *
 * Agent session start is exercised only when RUN_AGENT=1, since it spends
 * tokens and needs working Claude credentials.
 *
 * Usage: node test/smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PASSWORD = 'correct-horse-battery-staple';
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'rey-smoke-'));
const stateDir = join(scratch, 'state');
const projectsRoot = join(scratch, 'projects');
const demoProject = join(projectsRoot, 'demo-app');
mkdirSync(demoProject, { recursive: true });
writeFileSync(join(demoProject, 'package.json'), '{"name":"demo-app"}\n');
// A directory with no project marker must not appear in the scan.
mkdirSync(join(projectsRoot, 'not-a-project'), { recursive: true });

const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/reyd.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    REY_PASSWORD: PASSWORD,
    REY_PORT: String(PORT),
    REY_STATE_DIR: stateDir,
    REY_PROJECT_ROOTS: projectsRoot,
    REY_SERVE_WEB: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let daemonOut = '';
child.stdout.on('data', (d) => {
  daemonOut += d;
});
child.stderr.on('data', (d) => {
  daemonOut += d;
});

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function connect(token, { origin } = {}) {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws`, origin ? { origin } : {});
}

/** Collect server messages until `done(msg)` returns true, or timeout. */
function collect(ws, done, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for message; saw ${seen.map((m) => m.t).join(', ')}`));
    }, timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      if (done(msg, seen)) {
        cleanup();
        resolve({ msg, seen });
      }
    }
    function onClose(code, reason) {
      cleanup();
      resolve({ msg: null, seen, closed: { code, reason: reason.toString() } });
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  console.log(`\nscratch: ${scratch}`);

  console.log('\n== boot ==');
  const healthy = await waitForHealth();
  check('daemon answers /health', healthy, healthy ? '' : daemonOut.slice(-800));
  if (!healthy) return;

  const info = await (await fetch(`${BASE}/api/info`)).json();
  check('/api/info reports auth configured', info.authConfigured === true, JSON.stringify(info));
  check('/api/info reports protocol version', info.protocolVersion === 1);

  console.log('\n== auth: rejection path ==');
  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  const badBody = await bad.json();
  check('wrong password → 401', bad.status === 401, `got ${bad.status}`);
  check('wrong password → invalid_password', badBody.error === 'invalid_password', JSON.stringify(badBody));
  check('wrong password returns no token', badBody.token === undefined);

  // Second failure should engage per-key backoff.
  const bad2 = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-again' }),
  });
  const bad2Body = await bad2.json();
  check(
    'repeat failure throttled or rejected',
    bad2.status === 401 || bad2.status === 429,
    `status ${bad2.status} ${JSON.stringify(bad2Body)}`,
  );

  console.log('\n== auth: happy path ==');
  // Backoff after 2 failures is ~1s; wait it out so the real login is not throttled.
  await new Promise((r) => setTimeout(r, 1500));
  const good = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, label: 'smoke-test-phone' }),
  });
  const session = await good.json();
  check('correct password → 200', good.status === 200, `got ${good.status} ${JSON.stringify(session)}`);
  check('login returns a token', typeof session.token === 'string' && session.token.length > 20);
  check('login returns a deviceId', typeof session.deviceId === 'string');
  check('token expires in the future', session.expiresAt > Date.now());
  if (!session.token) return;

  console.log('\n== websocket: unauthenticated ==');
  const wsNoAuth = connect();
  await new Promise((r) => wsNoAuth.once('open', r));
  send(wsNoAuth, { t: 'sessions.list' });
  const refused = await collect(wsNoAuth, (m) => m.t === 'error');
  check(
    'command before hello → unauthorized',
    refused.msg?.code === 'unauthorized',
    JSON.stringify(refused.msg),
  );
  wsNoAuth.close();

  const wsBadToken = connect();
  await new Promise((r) => wsBadToken.once('open', r));
  send(wsBadToken, { t: 'hello', token: 'forged.999999999999.deadbeef', protocolVersion: 1 });
  const forged = await collect(wsBadToken, (m) => m.t === 'error');
  check('forged token rejected', forged.msg?.code === 'unauthorized', JSON.stringify(forged.msg));
  wsBadToken.close();

  const wsBadOrigin = connect(session.token, { origin: 'https://evil.example.com' });
  const originResult = await new Promise((resolve) => {
    wsBadOrigin.once('open', () => resolve('opened'));
    wsBadOrigin.once('error', () => resolve('rejected'));
  });
  check('disallowed Origin rejected at upgrade', originResult === 'rejected', originResult);

  // Regression: the daemon used to reject the origin of the page it had just
  // served, because only localhost and configured origins were allowed. Reaching
  // it by ANY hostname — which is what happens the moment it sits behind
  // `tailscale serve` — broke every WebSocket while login still worked.
  const wsSameOrigin = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    origin: 'https://desktop.example-tailnet.ts.net',
    headers: { host: 'desktop.example-tailnet.ts.net' },
  });
  const sameOriginResult = await new Promise((resolve) => {
    wsSameOrigin.once('open', () => resolve('opened'));
    wsSameOrigin.once('error', () => resolve('rejected'));
  });
  check('same-origin by Host header accepted', sameOriginResult === 'opened', sameOriginResult);
  if (sameOriginResult === 'opened') wsSameOrigin.close();

  // A reverse proxy may rewrite Host to the loopback it forwards to, so the
  // name the browser actually used survives only in X-Forwarded-Host.
  const wsForwarded = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    origin: 'https://desktop.example-tailnet.ts.net',
    headers: { host: '127.0.0.1:' + PORT, 'x-forwarded-host': 'desktop.example-tailnet.ts.net' },
  });
  const forwardedResult = await new Promise((resolve) => {
    wsForwarded.once('open', () => resolve('opened'));
    wsForwarded.once('error', () => resolve('rejected'));
  });
  check('same-origin via X-Forwarded-Host accepted', forwardedResult === 'opened', forwardedResult);
  if (forwardedResult === 'opened') wsForwarded.close();

  // The proxy case must not become a way to bypass the check entirely.
  const wsForgedForward = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    origin: 'https://evil.example.com',
    headers: { host: '127.0.0.1:' + PORT, 'x-forwarded-host': 'desktop.example-tailnet.ts.net' },
  });
  const forgedResult = await new Promise((resolve) => {
    wsForgedForward.once('open', () => resolve('opened'));
    wsForgedForward.once('error', () => resolve('rejected'));
  });
  check('mismatched Origin still rejected behind a proxy', forgedResult === 'rejected', forgedResult);

  console.log('\n== websocket: authenticated ==');
  const ws = connect();
  await new Promise((r) => ws.once('open', r));
  send(ws, { t: 'hello', token: session.token, protocolVersion: 1 });
  const hello = await collect(ws, (m) => m.t === 'hello.ok');
  check('hello.ok received', hello.msg?.t === 'hello.ok');
  check('hello.ok carries deviceId', hello.msg?.deviceId === session.deviceId);

  send(ws, { t: 'hello', token: session.token, protocolVersion: 99 });
  // Version mismatch closes the socket; a fresh one is needed afterwards.
  const mismatch = await collect(ws, (m) => m.t === 'error' && m.code === 'protocol_version');
  check('protocol version mismatch rejected', mismatch.msg?.code === 'protocol_version');

  const ws2 = connect();
  await new Promise((r) => ws2.once('open', r));
  send(ws2, { t: 'hello', token: session.token, protocolVersion: 1 });
  await collect(ws2, (m) => m.t === 'hello.ok');

  console.log('\n== projects ==');
  send(ws2, { t: 'projects.list', refresh: true });
  const projects = await collect(ws2, (m) => m.t === 'projects');
  const names = (projects.msg?.projects ?? []).map((p) => p.name);
  check('demo-app discovered', names.includes('demo-app'), JSON.stringify(names));
  check('marker-less dir excluded', !names.includes('not-a-project'), JSON.stringify(names));

  console.log('\n== path containment ==');
  send(ws2, {
    t: 'session.start',
    projectPath: process.platform === 'win32' ? 'C:\\Windows' : '/etc',
    permissionMode: 'default',
  });
  const escape = await collect(ws2, (m) => m.t === 'error');
  check(
    'session outside project roots refused',
    escape.msg?.code === 'project_not_allowed',
    JSON.stringify(escape.msg),
  );

  console.log('\n== devices ==');
  send(ws2, { t: 'devices.list' });
  const devices = await collect(ws2, (m) => m.t === 'devices');
  const list = devices.msg?.devices ?? [];
  check('device listed', list.length === 1, JSON.stringify(list.map((d) => d.label)));
  check('device labelled from login', list[0]?.label === 'smoke-test-phone');
  check('current device flagged', list[0]?.current === true);

  console.log('\n== revocation ==');
  send(ws2, { t: 'devices.revoke', deviceId: session.deviceId });
  const afterRevoke = await collect(ws2, (m) => m.t === 'devices' || m.t === 'error', 8000);
  check('revoke acknowledged', afterRevoke.msg !== null || afterRevoke.closed !== undefined);
  const wsRevoked = connect();
  await new Promise((r) => wsRevoked.once('open', r));
  send(wsRevoked, { t: 'hello', token: session.token, protocolVersion: 1 });
  const revokedResult = await collect(wsRevoked, (m) => m.t === 'error');
  check(
    'revoked token no longer authenticates',
    revokedResult.msg?.code === 'unauthorized',
    JSON.stringify(revokedResult.msg),
  );
  wsRevoked.close();

  // `--agent` works cross-shell; RUN_AGENT=1 is kept for POSIX habit.
  console.log('\n== live session control requests ==');
  // readFile and supportedModels are CLI control requests, not model calls, so
  // this costs nothing beyond starting the CLI — worth covering by default since
  // both back real UI features.
  {
    const login3 = await (
      await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, label: 'control-requests' }),
      })
    ).json();
    const ws = connect();
    await new Promise((r) => ws.once('open', r));
    send(ws, { t: 'hello', token: login3.token, protocolVersion: 1 });
    await collect(ws, (m) => m.t === 'hello.ok');

    send(ws, { t: 'session.start', projectPath: demoProject, permissionMode: 'default' });
    const created = await collect(ws, (m) => m.t === 'session.created', 60000).catch(() => ({ msg: null }));
    check('session started for control requests', created.msg?.session?.id !== undefined);

    if (created.msg?.session?.id) {
      const sessionId = created.msg.session.id;

      send(ws, { t: 'session.models', sessionId });
      const models = await collect(ws, (m) => m.t === 'session.modelList' || m.t === 'error', 60000).catch(
        (e) => ({ msg: null, error: e.message }),
      );
      check(
        'model list returned',
        models.msg?.t === 'session.modelList' && Array.isArray(models.msg.models) && models.msg.models.length > 0,
        JSON.stringify(models.msg?.models?.slice(0, 2) ?? models.msg ?? models.error),
      );
      if (models.msg?.models?.length) {
        const first = models.msg.models[0];
        check(
          'model entries have value and label',
          typeof first.value === 'string' && typeof first.label === 'string',
          JSON.stringify(first),
        );
      }

      send(ws, { t: 'session.readFile', sessionId, path: 'package.json', requestId: 'r1' });
      const file = await collect(ws, (m) => m.t === 'session.fileContent', 60000).catch((e) => ({
        msg: null,
        error: e.message,
      }));
      check(
        'readFile returned the real file contents',
        typeof file.msg?.content === 'string' && file.msg.content.includes('demo-app'),
        JSON.stringify(file.msg ?? file.error).slice(0, 200),
      );

      send(ws, { t: 'session.readFile', sessionId, path: 'does-not-exist.txt', requestId: 'r2' });
      const missing = await collect(ws, (m) => m.t === 'session.fileContent' && m.requestId === 'r2', 60000).catch(
        (e) => ({ msg: null, error: e.message }),
      );
      check(
        'a missing file reports a reason instead of empty content',
        missing.msg?.content === null && typeof missing.msg?.error === 'string',
        JSON.stringify(missing.msg ?? missing.error).slice(0, 200),
      );

      send(ws, { t: 'session.diff', sessionId, scope: 'project' });
      const diff = await collect(ws, (m) => m.t === 'session.diffResult', 60000).catch((e) => ({
        msg: null,
        error: e.message,
      }));
      // demoProject is not a git repo, so the daemon must say so rather than fail.
      check(
        'diff on a non-repo reports why',
        diff.msg?.diff?.available === false && /not a git repository|git is not installed/.test(diff.msg.diff.reason),
        JSON.stringify(diff.msg?.diff ?? diff.error),
      );

      send(ws, { t: 'session.stop', sessionId });
    }
    ws.close();
  }

  console.log('\n== git diff in a real repo ==');
  {
    // A real repo with a real uncommitted change, so the patch path is exercised
    // rather than only the "not a repo" branch.
    const repo = join(projectsRoot, 'git-demo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"git-demo"}\n');
    writeFileSync(join(repo, 'tracked.txt'), 'line one\nline two\nline three\n');
    const git = (args) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    git(['init', '-q']);
    git(['config', 'user.email', 'smoke@example.com']);
    git(['config', 'user.name', 'Smoke Test']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
    // Now change a tracked file and add an untracked one.
    writeFileSync(join(repo, 'tracked.txt'), 'line one\nCHANGED\nline three\n');
    writeFileSync(join(repo, 'brand-new.txt'), 'new file\n');

    const login4 = await (
      await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, label: 'git-diff' }),
      })
    ).json();
    const ws = connect();
    await new Promise((r) => ws.once('open', r));
    send(ws, { t: 'hello', token: login4.token, protocolVersion: 1 });
    await collect(ws, (m) => m.t === 'hello.ok');

    send(ws, { t: 'projects.list', refresh: true });
    await collect(ws, (m) => m.t === 'projects');

    send(ws, { t: 'session.start', projectPath: repo, permissionMode: 'default' });
    const created = await collect(ws, (m) => m.t === 'session.created', 60000).catch(() => ({ msg: null }));
    check('session started in git repo', created.msg?.session?.id !== undefined);

    if (created.msg?.session?.id) {
      const sessionId = created.msg.session.id;
      send(ws, { t: 'session.diff', sessionId });
      const res = await collect(ws, (m) => m.t === 'session.diffResult', 60000).catch((e) => ({
        msg: null,
        error: e.message,
      }));
      const d = res.msg?.diff;
      check('diff available in a git repo', d?.available === true, JSON.stringify(d ?? res.error).slice(0, 200));
      check(
        'patch contains the changed line',
        typeof d?.patch === 'string' && d.patch.includes('CHANGED') && d.patch.includes('tracked.txt'),
        (d?.patch ?? '').slice(0, 160),
      );
      check(
        'untracked file reported',
        Array.isArray(d?.untracked) && d.untracked.includes('brand-new.txt'),
        JSON.stringify(d?.untracked),
      );
      check('branch reported', typeof d?.branch === 'string' && d.branch.length > 0, JSON.stringify(d?.branch));
      check(
        'project scope reported',
        d?.scope === 'project',
        JSON.stringify({ scope: d?.scope, fellBack: d?.scopeFellBack }),
      );

      // Session scope with no writes yet must fall back to the project view and
      // say so, rather than silently reporting "nothing changed".
      send(ws, { t: 'session.diff', sessionId, scope: 'session' });
      const scoped = await collect(ws, (m) => m.t === 'session.diffResult', 60000).catch((e) => ({
        msg: null,
        error: e.message,
      }));
      const s = scoped.msg?.diff;
      check(
        'session scope falls back when nothing was written',
        s?.scopeFellBack === true && s?.scope === 'project',
        JSON.stringify({ scope: s?.scope, fellBack: s?.scopeFellBack }),
      );
      check(
        'fallback still shows the real change',
        typeof s?.patch === 'string' && s.patch.includes('CHANGED'),
        (s?.patch ?? '').slice(0, 80),
      );

      send(ws, { t: 'session.stop', sessionId });
    }
    ws.close();
  }

  if (process.env.RUN_AGENT === '1' || process.argv.includes('--agent')) {
    console.log('\n== live agent session (RUN_AGENT=1) ==');
    const login2 = await (
      await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, label: 'agent-run' }),
      })
    ).json();
    const ws3 = connect();
    await new Promise((r) => ws3.once('open', r));
    send(ws3, { t: 'hello', token: login2.token, protocolVersion: 1 });
    await collect(ws3, (m) => m.t === 'hello.ok');
    send(ws3, {
      t: 'session.start',
      projectPath: demoProject,
      permissionMode: 'default',
      prompt: 'Reply with exactly the word: pong',
    });
    const created = await collect(ws3, (m) => m.t === 'session.created', 30000);
    check('session created', created.msg?.session?.id !== undefined, JSON.stringify(created.msg?.session));
    const result = await collect(
      ws3,
      (m) => m.t === 'event' && m.message?.type === 'result',
      120000,
    ).catch((e) => ({ msg: null, error: e.message }));
    check('agent produced a result event', result.msg !== null, result.error ?? '');
    if (result.msg) {
      const seqs = result.seen.filter((m) => m.t === 'event').map((m) => m.seq);
      const gapless = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
      check('event seq is gapless', gapless, JSON.stringify(seqs.slice(0, 12)));
    }
    ws3.close();
    console.log('\n== session-scoped diff (live agent) ==');
    // The scoping path can only be exercised by a real tool call: touched files are
    // gathered from the PreToolUse hook. Two files are dirty; the agent edits one,
    // and session scope must show only that one.
    {
      const repo = join(projectsRoot, 'scope-demo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"scope-demo"}\n');
      writeFileSync(join(repo, 'agent-target.txt'), 'before\n');
      writeFileSync(join(repo, 'my-own-work.txt'), 'mine\n');
      const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      g(['init', '-q']);
      g(['config', 'user.email', 'smoke@example.com']);
      g(['config', 'user.name', 'Smoke']);
      g(['add', '.']);
      g(['commit', '-q', '-m', 'initial']);
      // Pre-existing uncommitted work that the session must NOT claim.
      writeFileSync(join(repo, 'my-own-work.txt'), 'mine, edited by hand\n');

      const lg = await (
        await fetch(`${BASE}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: PASSWORD, label: 'scope' }),
        })
      ).json();
      const ws4 = connect();
      await new Promise((r) => ws4.once('open', r));
      send(ws4, { t: 'hello', token: lg.token, protocolVersion: 1 });
      await collect(ws4, (m) => m.t === 'hello.ok');
      send(ws4, { t: 'projects.list', refresh: true });
      await collect(ws4, (m) => m.t === 'projects');

      send(ws4, {
        t: 'session.start',
        projectPath: repo,
        permissionMode: 'bypassPermissions',
        prompt: 'Replace the entire contents of agent-target.txt with the single word: after',
      });
      const c2 = await collect(ws4, (m) => m.t === 'session.created', 60000).catch(() => ({ msg: null }));
      if (c2.msg?.session?.id) {
        const sid2 = c2.msg.session.id;
        await collect(ws4, (m) => m.t === 'event' && m.message?.type === 'result', 200000).catch(() => null);

        send(ws4, { t: 'session.diff', sessionId: sid2, scope: 'session' });
        const sc = await collect(ws4, (m) => m.t === 'session.diffResult', 60000).catch(() => ({ msg: null }));
        const sd = sc.msg?.diff;
        check(
          'session scope includes the file the agent edited',
          typeof sd?.patch === 'string' && sd.patch.includes('agent-target.txt'),
          (sd?.patch ?? '').slice(0, 120),
        );
        check(
          'session scope excludes my own uncommitted work',
          typeof sd?.patch === 'string' && !sd.patch.includes('my-own-work.txt'),
          (sd?.patch ?? '').slice(0, 200),
        );
        check('session scope reported as session', sd?.scope === 'session' && !sd?.scopeFellBack, JSON.stringify({ scope: sd?.scope, fellBack: sd?.scopeFellBack }));

        send(ws4, { t: 'session.diff', sessionId: sid2, scope: 'project' });
        const pj = await collect(ws4, (m) => m.t === 'session.diffResult', 60000).catch(() => ({ msg: null }));
        check(
          'project scope includes both files',
          typeof pj.msg?.diff?.patch === 'string' &&
            pj.msg.diff.patch.includes('agent-target.txt') &&
            pj.msg.diff.patch.includes('my-own-work.txt'),
          (pj.msg?.diff?.patch ?? '').slice(0, 200),
        );

        // Persistence is the point: a session resumed after a daemon restart must
        // keep its scope, so the touched set has to be on disk, not only in memory.
        const persisted = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'));
        const savedFiles = persisted.sessions?.[sid2]?.touchedFiles;
        check(
          'touched files persisted to sessions.json',
          Array.isArray(savedFiles) && savedFiles.includes('agent-target.txt'),
          JSON.stringify(savedFiles),
        );
        check(
          'persisted set excludes files the agent did not write',
          Array.isArray(savedFiles) && !savedFiles.includes('my-own-work.txt'),
          JSON.stringify(savedFiles),
        );

        send(ws4, { t: 'session.stop', sessionId: sid2 });
      } else {
        check('scoped-diff session started', false, 'session did not start');
      }
      ws4.close();
    }
  } else {
    console.log('\n== live agent session skipped (set RUN_AGENT=1 to include) ==');
  }

  ws2.close();
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error(`\nsmoke test threw: ${err.stack}`);
  console.error(`\ndaemon output:\n${daemonOut.slice(-2000)}`);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  if (!child.killed) child.kill('SIGKILL');
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds the log file briefly; scratch is in tmp anyway.
  }
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
