/**
 * Diagnostic (not part of the suite): does rewindFiles accept the uuid the daemon
 * assigns to a user message?
 *
 * The question matters because the CLI does not echo user prompts on the stream,
 * so a client cannot learn a CLI-assigned uuid. If the CLI ignores the uuid we set
 * on SDKUserMessage, rewind-by-user-message is not reachable from an SDK client and
 * the UI must say so rather than offering an action that cannot work.
 *
 * Run: node test/rewind-check.mjs   (from packages/daemon; spends tokens)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PASSWORD = 'rewind-check-pw-123';
const PORT = 8834;
const BASE = `http://127.0.0.1:${PORT}`;

const scratch = mkdtempSync(join(tmpdir(), 'rey-rw-'));
const root = join(scratch, 'projects');
const proj = join(root, 'demo');
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'package.json'), '{"name":"demo"}\n');
writeFileSync(join(proj, 'target.txt'), 'original contents\n');

const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/bin/reyd.ts'], {
  cwd: '.',
  env: {
    ...process.env,
    REY_PASSWORD: PASSWORD,
    REY_PORT: String(PORT),
    REY_STATE_DIR: join(scratch, 'state'),
    REY_PROJECT_ROOTS: root,
    REY_SERVE_WEB: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
daemon.stdout.on('data', (d) => (log += d));
daemon.stderr.on('data', (d) => (log += d));

const until = async (fn, ms = 30000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
if (!(await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }))) {
  console.error('daemon did not start\n', log);
  process.exit(1);
}

const { token } = await (
  await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
).json();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r) => ws.once('open', r));

const eventTypes = [];
const userUuids = [];
const toolCalls = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t !== 'event') return;
  const type = m.message?.type;
  if (type && type !== 'stream_event') eventTypes.push(type);
  if (type === 'user' && m.message?.uuid) userUuids.push(m.message.uuid);
  if (type === 'assistant') {
    for (const b of m.message?.message?.content ?? []) {
      if (b.type === 'tool_use') toolCalls.push(b.name);
    }
  }
});

const waitFor = (pred, ms = 220000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) {
        clearTimeout(t);
        ws.off('message', h);
        res(m);
      }
    };
    ws.on('message', h);
  });

ws.send(JSON.stringify({ t: 'hello', token, protocolVersion: 1 }));
await waitFor((m) => m.t === 'hello.ok');

ws.send(
  JSON.stringify({
    t: 'session.start',
    projectPath: proj,
    permissionMode: 'bypassPermissions',
    prompt: 'Replace the entire contents of target.txt with the single word: changed',
  }),
);
const created = await waitFor((m) => m.t === 'session.created');
const sid = created.session.id;

await waitFor((m) => m.t === 'event' && m.message?.type === 'result');

const target = join(proj, 'target.txt');
const after = existsSync(target) ? (await import('node:fs')).readFileSync(target, 'utf8').trim() : '(missing)';

console.log('event types      :', JSON.stringify(eventTypes));
console.log('tool calls       :', JSON.stringify(toolCalls));
console.log('user uuids on bus:', JSON.stringify(userUuids));
console.log('target.txt now   :', JSON.stringify(after));

// Anchors from the CLI's own session history, not from the message stream.
ws.send(JSON.stringify({ t: 'session.checkpoints', sessionId: sid }));
const cps = await waitFor((m) => m.t === 'session.checkpointList', 60000);
console.log('checkpoints      :', JSON.stringify(cps.checkpoints), cps.error ?? '');

const uuid = cps.checkpoints.at(-1)?.uuid;
if (!uuid) {
  console.log('no checkpoint available — cannot attempt rewind');
} else {
  ws.send(JSON.stringify({ t: 'session.rewind', sessionId: sid, userMessageId: uuid, dryRun: true }));
  const dry = await waitFor((m) => m.t === 'session.rewound' && m.dryRun === true, 60000);
  console.log('DRY RUN          :', JSON.stringify(dry.result));

  ws.send(JSON.stringify({ t: 'session.rewind', sessionId: sid, userMessageId: uuid, dryRun: false }));
  const real = await waitFor((m) => m.t === 'session.rewound' && m.dryRun === false, 60000);
  console.log('REAL RUN         :', JSON.stringify(real.result));

  const restored = existsSync(target) ? (await import('node:fs')).readFileSync(target, 'utf8').trim() : '(missing)';
  console.log('target.txt after :', JSON.stringify(restored));
  console.log(
    restored === 'original contents' ? '=> REWIND WORKS with a daemon-assigned uuid' : '=> REWIND DID NOT RESTORE',
  );
}

ws.send(JSON.stringify({ t: 'session.stop', sessionId: sid }));
await new Promise((r) => setTimeout(r, 1500));
ws.close();
daemon.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 800));
try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  /* windows handle */
}
process.exit(0);
