/**
 * Integration test for the extension's DaemonClient against a real daemon.
 *
 * The extension's UI cannot be tested without a VSCode host, but the part that can
 * actually be wrong — auth, connection lifecycle, session tracking — is all in
 * DaemonClient, and that runs in plain Node. So it is tested directly.
 *
 * Requires a built extension: pnpm --filter agent-rey-vscode build
 * Run: node --test packages/vscode/test/client.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DaemonClient } = require('../dist/daemon-client.js');

const PASSWORD = 'vscode-integration-password';
const PORT = 8821;
const BASE = `http://127.0.0.1:${PORT}`;

let daemon;
let scratch;
let demoProject;
let log = '';

function waitFor(predicate, timeoutMs = 15_000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'rey-vsc-'));
  const projectsRoot = join(scratch, 'projects');
  demoProject = join(projectsRoot, 'ext-demo');
  mkdirSync(demoProject, { recursive: true });
  writeFileSync(join(demoProject, 'package.json'), '{"name":"ext-demo"}\n');

  const daemonDir = fileURLToPath(new URL('../../daemon/', import.meta.url));
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/bin/reyd.ts'], {
    cwd: daemonDir,
    env: {
      ...process.env,
      REY_PASSWORD: PASSWORD,
      REY_PORT: String(PORT),
      REY_STATE_DIR: join(scratch, 'state'),
      REY_PROJECT_ROOTS: projectsRoot,
      REY_SERVE_WEB: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => (log += d));
  daemon.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`daemon did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(async () => {
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  if (daemon && !daemon.killed) daemon.kill('SIGKILL');
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* Windows handle */
  }
});

test('reports the daemon as reachable', async () => {
  const client = new DaemonClient(BASE);
  assert.equal(await client.isDaemonReachable(), true);
  client.dispose();
});

test('reports an unreachable daemon rather than hanging', async () => {
  const client = new DaemonClient('http://127.0.0.1:8899');
  assert.equal(await client.isDaemonReachable(), false);
  client.dispose();
});

test('rejects a wrong password with a usable message', async () => {
  const client = new DaemonClient(BASE);
  const result = await client.login('not-the-password');
  assert.equal(result.ok, false);
  assert.match(result.message, /Wrong password/);
  client.dispose();
});

test('login yields a token and the socket reaches online', async () => {
  const client = new DaemonClient(BASE);
  const result = await client.login(PASSWORD);
  assert.equal(result.ok, true);
  assert.ok(result.token.length > 20);

  client.start(result.token);
  await waitFor(() => client.status === 'online', 15_000, 'status online');
  assert.equal(client.status, 'online');
  client.dispose();
});

test('a forged token lands in unauthenticated, not a reconnect loop', async () => {
  const client = new DaemonClient(BASE);
  client.start('forged.99999999999999.deadbeef');
  await waitFor(() => client.status === 'unauthenticated', 15_000, 'status unauthenticated');
  assert.equal(client.status, 'unauthenticated');
  client.dispose();
});

test('lists projects the daemon allows', async () => {
  const client = new DaemonClient(BASE);
  const { token } = await client.login(PASSWORD);
  client.start(token);
  await waitFor(() => client.status === 'online', 15_000, 'online');

  const projects = await client.requestProjects();
  assert.ok(
    projects.some((p) => p.name === 'ext-demo'),
    `expected ext-demo in ${JSON.stringify(projects.map((p) => p.name))}`,
  );
  client.dispose();
});

test('starting a session surfaces it in the session list', async () => {
  const client = new DaemonClient(BASE);
  const { token } = await client.login(PASSWORD);
  client.start(token);
  await waitFor(() => client.status === 'online', 15_000, 'online');

  client.startSession({ projectPath: demoProject, permissionMode: 'default' });
  await waitFor(() => client.sessions.length > 0, 30_000, 'a session to appear');

  const session = client.sessions[0];
  assert.equal(session.projectPath, demoProject);
  assert.equal(session.permissionMode, 'default');

  client.stopSession(session.id);
  await waitFor(
    () => client.sessions.every((s) => s.status === 'exited'),
    20_000,
    'session to stop',
  );
  client.dispose();
});

test('refuses to start a session outside the daemon\u2019s project roots', async () => {
  const client = new DaemonClient(BASE);
  const { token } = await client.login(PASSWORD);
  client.start(token);
  await waitFor(() => client.status === 'online', 15_000, 'online');

  const errors = [];
  client.on('error', (m) => errors.push(m));
  client.startSession({
    projectPath: process.platform === 'win32' ? 'C:\\Windows' : '/etc',
    permissionMode: 'default',
  });

  await waitFor(() => errors.length > 0, 15_000, 'a containment error');
  assert.match(errors[0], /not inside a configured project root/);
  client.dispose();
});

test('dispose stops reconnecting', async () => {
  const client = new DaemonClient(BASE);
  const { token } = await client.login(PASSWORD);
  client.start(token);
  await waitFor(() => client.status === 'online', 15_000, 'online');

  client.dispose();
  await new Promise((r) => setTimeout(r, 2500));
  // A disposed client must not claw its way back online, or deactivating the
  // extension would leave a live socket behind.
  assert.notEqual(client.status, 'online');
});
