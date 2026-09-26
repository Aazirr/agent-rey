import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store, classifyFailure } from '../src/store.mjs';
import { Manager } from '../src/manager.mjs';
import { toolDecision, validateScope, claudeEnvironment } from '../src/policy.mjs';
import { runClaude } from '../src/claude.mjs';
import { executeWorker } from '../src/worker.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rey-bridge-test-'));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString();
  git(['init']); git(['config', 'user.name', 'Bridge Test']); git(['config', 'user.email', 'test@example.invalid']);
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'page.txt'), 'before'); git(['add', '.']); git(['commit', '-m', 'test: fixture']);
  const store = new Store(join(dir, 'state')); store.write('config.json', { allowedProjectRoots: [dir] });
  let launches = 0;
  const manager = new Manager(store, () => { launches++; });
  return { dir, repo, git, store, manager, launches: () => launches };
}
function start(f) { return f.manager.start({ projectPath: f.repo, title: 'UI task', brief: 'Change the frontend page', allowedPaths: ['src'] }); }
function fakeQuery(messages, inspect) {
  return args => {
    inspect?.(args);
    return { async *[Symbol.asyncIterator]() { for (const m of messages) yield m; }, close() {} };
  };
}
const success = { type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'fake-session', permission_denials: [] };

test('clean repo gets an isolated worktree and rejects global concurrent work', () => {
  const f = fixture(); const task = start(f);
  assert.notEqual(task.worktree, f.repo);
  writeFileSync(join(task.worktree, 'src', 'page.txt'), 'after');
  assert.equal(readFileSync(join(f.repo, 'src', 'page.txt'), 'utf8'), 'before');
  assert.throws(() => start(f), /already reserved/);
  assert.equal(f.launches(), 1);
  assert.match(f.manager.result(task.id).diff, /after/);
});
test('dirty repo is rejected without stash, reset or worktree creation', () => {
  const f = fixture(); writeFileSync(join(f.repo, 'src', 'page.txt'), 'user work');
  assert.throws(() => start(f), /uncommitted/);
  assert.equal(f.launches(), 0);
  assert.equal(readFileSync(join(f.repo, 'src', 'page.txt'), 'utf8'), 'user work');
});
test('project outside configured roots is rejected', () => {
  const f = fixture(); f.store.write('config.json', { allowedProjectRoots: [join(f.dir, 'state')] });
  const m = new Manager(f.store, () => assert.fail('must not launch'));
  assert.throws(() => m.start({ projectPath: f.repo, title: 'x', brief: 'frontend', allowedPaths: ['src'] }), /outside/);
});
test('scope supports Next.js route brackets and blocks path/glob escapes', () => {
  assert.deepEqual(validateScope(['src/app/(staff)/[id]']), ['src/app/(staff)/[id]']);
  for (const p of ['../x', '.', '/', 'src/../secret', '.env', 'src/*', 'src/file:ads', '.git/hooks']) assert.throws(() => validateScope([p]));
});
test('file tools enforce scope, credentials, junctions, traversal, and no shell', () => {
  const f = fixture(); const task = start(f);
  const decide = (name, input) => toolDecision(task, name, input).behavior;
  assert.equal(decide('Write', { file_path: join(task.worktree, 'src', 'new.tsx') }), 'allow');
  assert.equal(decide('Read', { file_path: 'package.json' }), 'allow');
  assert.equal(decide('Write', { file_path: 'backend.ts' }), 'deny');
  for (const path of ['.env', '.env.local', '.git/config', '.mcp.json', '../escape', 'src/file:ads']) assert.equal(decide('Read', { file_path: path }), 'deny');
  assert.equal(decide('Glob', { pattern: '../../*' }), 'deny');
  assert.equal(decide('Bash', { command: 'echo hi' }), 'deny');
  assert.equal(decide('Grep', { pattern: 'secret' }), 'deny');
  symlinkSync(f.repo, join(task.worktree, 'src', 'linked'), 'junction');
  assert.equal(decide('Write', { file_path: 'src/linked/page.txt' }), 'deny');
  assert.equal(decide('Read', { file_path: 'src/linked/src/page.txt' }), 'deny');
});
test('subprocess environment excludes API fallback keys and unrelated secrets', () => {
  const env = claudeEnvironment({ PATH: 'bin', USERPROFILE: 'user', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://wrong.invalid' });
  assert.deepEqual(env, { PATH: 'bin', USERPROFILE: 'user' });
});
for (const [code, detail, kind] of [
  ['authentication_failed', 'expired', 'authentication'], ['unknown', 'Your account has been disabled', 'account_disabled'],
  ['oauth_org_not_allowed', '', 'account_disabled'], ['rate_limit', '', 'usage_limit'], ['billing_error', '', 'billing'],
  ['model_not_found', '', 'model'], ['server_error', '', 'unavailable'],
]) {
  test(`provider failure ${code}/${kind} preserves partial work and asks user`, async () => {
    const f = fixture(); const task = start(f);
    writeFileSync(join(task.worktree, 'src', 'page.txt'), 'partial work');
    await executeWorker(f.store, task.id, task.runId, (t, c, opts) => runClaude(t, c, { ...opts, queryImpl: fakeQuery([{ type: 'assistant', error: code, message: { content: [{ type: 'text', text: detail }] } }]) }));
    const result = f.manager.get(task.id);
    assert.equal(result.status, 'blocked'); assert.equal(result.needsUserDecision.required, true);
    assert.equal(f.store.circuit().kind, kind);
    assert.equal(new Store(f.store.root).circuit().state, 'blocked');
    assert.equal(readFileSync(join(task.worktree, 'src', 'page.txt'), 'utf8'), 'partial work');
    assert.throws(() => start(f), /delegation blocked/);
    assert.equal(f.launches(), 1);
    assert.throws(() => f.manager.handoff(task.id, false), /Ask the user/);
    assert.equal(f.manager.handoff(task.id, true).status, 'handed_off');
    f.store.write('account.json', { state: 'ready' });
    assert.throws(() => f.manager.feedback(task.id, 'resume'), /Handed-off/);
  });
}
test('probe recovers circuit but never resumes blocked task automatically', async () => {
  const f = fixture(); f.store.trip(classifyFailure('authentication_failed'));
  const probe = f.manager.probe();
  await executeWorker(f.store, probe.id, probe.runId, async () => ({ status: 'completed', result: 'REY_ACCOUNT_OK' }));
  assert.equal(f.store.circuit().state, 'ready'); assert.equal(f.launches(), 1);
  assert.equal(f.manager.list().length, 1);
});
test('future provider reset prevents premature explicit checks', () => {
  const f = fixture(); f.store.trip(classifyFailure('rate_limit', '', Date.now() / 1000 + 3600));
  assert.throws(() => f.manager.probe(), /not due/); assert.equal(f.launches(), 0);
});
test('unexpected probe text cannot clear a blocked circuit', async () => {
  const f = fixture(); f.store.trip(classifyFailure('authentication_failed'));
  const p = f.manager.probe(); await executeWorker(f.store, p.id, p.runId, async () => ({ status: 'completed', result: 'maybe' }));
  assert.equal(f.store.circuit().state, 'blocked');
});
test('normal prose and allowed warnings do not trip account circuit', async () => {
  const result = await runClaude({ kind: 'probe', worktree: tmpdir(), prompt: 'test' }, {}, { queryImpl: fakeQuery([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Handle authentication_failed in your UI.' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, success,
  ], ({ options }) => {
    assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []); assert.equal(options.strictMcpConfig, true);
    assert.equal(options.permissionMode, 'default'); assert.equal(options.allowDangerouslySkipPermissions, undefined);
  }) });
  assert.equal(result.status, 'completed');
});
test('rejected limits and API retry notifications stop without replay', async () => {
  for (const msg of [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }, { type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429 }]) {
    const result = await runClaude({ kind: 'probe', worktree: tmpdir(), prompt: 'test' }, {}, { queryImpl: fakeQuery([msg, success]) });
    assert.equal(result.status, 'blocked'); assert.equal(result.failure.kind, 'usage_limit');
  }
});
test('cancellation preserves files and releases reservation before handoff', async () => {
  const f = fixture(); const task = start(f); f.manager.cancel(task.id);
  await executeWorker(f.store, task.id, task.runId, async (_t, _c, { signal }) => {
    assert.equal(signal.aborted, true); return { status: 'interrupted' };
  });
  assert.equal(f.store.read('active.json'), null);
  assert.equal(f.manager.handoff(task.id, true).status, 'handed_off');
  assert.equal(existsSync(task.worktree), true);
});
test('stale process is marked interrupted, not retried or deleted', () => {
  const f = fixture(); const task = start(f);
  f.store.write('active.json', { taskId: task.id, runId: task.runId, pid: 999999999, at: Date.now() - 60000 });
  assert.equal(f.manager.get(task.id).status, 'interrupted'); assert.equal(f.launches(), 1);
  assert.equal(f.store.read('active.json'), null);
});
test('corrupt persisted circuit fails closed', () => {
  const f = fixture(); writeFileSync(join(f.store.root, 'account.json'), '{broken');
  assert.throws(() => start(f)); assert.equal(f.launches(), 0);
});
test('SDK exception sanitizes sensitive text rather than returning it', async () => {
  const result = await runClaude({ kind: 'probe', worktree: tmpdir(), prompt: 'test' }, {}, { queryImpl: () => { throw new Error('401 secret-token-example'); } });
  assert.equal(result.failure.kind, 'authentication');
  assert.equal(JSON.stringify(result).includes('secret-token-example'), false);
});
test('max turn and permission blockers request attention without disabling account', async () => {
  const result = await runClaude({ kind: 'probe', worktree: tmpdir(), prompt: 'test' }, {}, { queryImpl: fakeQuery([{ type: 'result', subtype: 'error_max_turns', is_error: true }]) });
  assert.equal(result.status, 'needs_attention');
});

test('quietly closed cancelled stream does not trip the account circuit', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runClaude({ kind: 'probe', worktree: tmpdir(), prompt: 'test' }, {}, { signal: controller.signal, queryImpl: fakeQuery([]) });
  assert.equal(result.status, 'interrupted'); assert.equal(result.failure, undefined);
});
