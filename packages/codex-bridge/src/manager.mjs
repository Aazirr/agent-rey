import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store, loadConfig } from './store.mjs';
import { inside, validateScope, safePath } from './policy.mjs';

export const fallbackDecision = {
  required: true,
  question: 'Claude is unavailable. Would you like to wait/reconnect and continue this frontend task with Claude, or have Codex continue from the preserved work?',
  choices: ['Continue with Claude after account recovery', 'Proceed with Codex instead'],
  instruction: 'Ask the user now. Do not choose automatically, retry, reset the circuit, change credentials, or redo the task from scratch.',
};
const git = (cwd, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

export class Manager {
  constructor(store = new Store(), launch = defaultLaunch) { this.store = store; this.config = loadConfig(store); this.launch = launch; }
  status() {
    this.store.recoverStale();
    const account = this.store.circuit();
    return { account, active: this.store.read('active.json'), allowedProjectRoots: this.config.allowedProjectRoots,
      ...(account.state === 'blocked' ? { needsUserDecision: fallbackDecision } : {}),
      notice: 'This status is local-only; it makes no Claude request. Account access can change after a successful check.' };
  }
  list() {
    this.store.recoverStale();
    return readdirSync(join(this.store.root, 'tasks')).filter(n => n.endsWith('.json')).map(n => {
      const t = this.store.read(`tasks/${n}`);
      return { id: t.id, title: t.title, status: t.status, projectPath: t.projectPath, worktree: t.worktree, updatedAt: t.updatedAt };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
  }
  get(id) {
    this.store.recoverStale();
    const t = this.store.task(id);
    return { ...t, ...(t.status === 'blocked' ? { needsUserDecision: fallbackDecision } : {}) };
  }
  start({ projectPath, title, brief, allowedPaths }) {
    this.store.recoverStale(); this.store.assertAvailable();
    const scope = validateScope(allowedPaths);
    if (!isAbsolute(projectPath)) throw new Error('projectPath must be absolute.');
    const project = realpathSync.native(projectPath);
    if (!this.config.allowedProjectRoots.some(r => existsSync(r) && inside(realpathSync.native(r), project))) throw new Error('Project is outside allowedProjectRoots; ask the user before adding its parent to bridge config.json.');
    const repoRoot = realpathSync.native(git(project, ['rev-parse', '--show-toplevel']).trim());
    if (repoRoot !== project) throw new Error('Choose the Git repository root, not a subdirectory.');
    if (git(project, ['status', '--porcelain']).trim()) throw new Error('Repository has uncommitted changes. Preserve/review them and commit the intended baseline before delegation; do not auto-stash or discard them.');
    const baseCommit = git(project, ['rev-parse', '--verify', 'HEAD']).trim();
    const id = randomUUID(); const runId = randomUUID();
    const worktree = join(this.store.root, 'worktrees', id);
    const task = { id, runId, kind: 'frontend', title, brief, allowedPaths: scope, projectPath: project, baseCommit, worktree, status: 'starting', createdAt: new Date().toISOString(), prompt: makePrompt(brief, scope), attempts: 1 };
    this.store.acquire(id, runId);
    try {
      this.store.save(task);
      // No user git hooks are run while creating the isolated checkout.
      git(project, ['-c', `core.hooksPath=${join(this.store.root, 'no-hooks')}`, 'worktree', 'add', '--detach', worktree, baseCommit]);
      task.worktree = realpathSync.native(worktree);
      for (const p of scope) safePath(realpathSync.native(worktree), p);
      this.store.save(task);
      this.launch(task, this.store);
      return this.get(id);
    } catch (e) {
      task.status = 'failed'; task.reason = 'Could not prepare/start worker. Any created worktree is preserved for inspection.';
      this.store.save(task); this.store.release(id, runId); throw e;
    }
  }
  probe() {
    this.store.recoverStale();
    const circuit = this.store.circuit();
    if (circuit.retryAfter && Date.parse(circuit.retryAfter) > Date.now()) throw new Error(`Claude usage reset is not due until ${circuit.retryAfter}. Ask whether Codex should take over instead.`);
    const id = randomUUID(); const runId = randomUUID();
    const task = { id, runId, kind: 'probe', title: 'Explicit Claude account check', allowedPaths: [], worktree: join(this.store.root, 'probe'), status: 'starting', createdAt: new Date().toISOString(), prompt: 'Reply with exactly REY_ACCOUNT_OK. Do not use any tools.', attempts: 1 };
    this.store.acquire(id, runId);
    try { this.store.save(task); this.launch(task, this.store); return this.get(id); }
    catch (e) { task.status = 'failed'; this.store.save(task); this.store.release(id, runId); throw e; }
  }
  feedback(id, message) {
    this.store.recoverStale(); this.store.assertAvailable();
    const task = this.store.task(id);
    if (task.kind !== 'frontend' || ['starting', 'running', 'handed_off'].includes(task.status)) throw new Error('Only an idle, owned frontend task may receive feedback. Handed-off tasks cannot restart.');
    task.runId = randomUUID();
    this.store.acquire(id, task.runId);
    try {
      task.previousResult = task.result; task.feedback = message;
      task.prompt = makePrompt(`${task.brief}\n\nLatest feedback: ${message}\nInspect existing partial files before making further edits.`, task.allowedPaths);
      task.status = 'starting'; task.reason = undefined; task.failure = undefined; task.deniedTools = [];
      task.result = undefined; task.estimatedCostUsd = undefined; task.completedAt = undefined;
      task.attempts += 1; this.store.save(task); this.launch(task, this.store); return this.get(id);
    } catch (e) { task.status = 'failed'; this.store.save(task); this.store.release(id, task.runId); throw e; }
  }
  cancel(id) {
    const task = this.get(id);
    if (['starting', 'running'].includes(task.status)) writeFileSync(join(this.store.root, 'tasks', `${id}.${task.runId}.cancel`), 'cancel\n', { mode: 0o600 });
    return { taskId: id, requested: ['starting', 'running'].includes(task.status), instruction: 'Wait for terminal status before editing the worktree or starting a replacement.' };
  }
  handoff(id, confirmed) {
    if (confirmed !== true) throw new Error('Ask the user to choose Codex before handing off.');
    const task = this.get(id);
    if (task.kind !== 'frontend') throw new Error('An account probe has no frontend work to hand off.');
    if (['starting', 'running'].includes(task.status)) throw new Error('Cancel and wait for terminal status before handing off.');
    task.status = 'handed_off'; task.handoffAt = new Date().toISOString(); this.store.save(task);
    return { ...task, instruction: 'Codex now owns this worktree. Inspect existing changes, continue the same brief, test, integrate deliberately, update /docs, and follow project commit/push rules. Do not restart Claude for this task.' };
  }
  result(id) {
    const task = this.get(id);
    if (task.kind === 'probe' || !existsSync(task.worktree)) return task;
    const status = git(task.worktree, ['status', '--porcelain=v1']);
    const diff = git(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', task.baseCommit, '--']);
    return { ...task, gitStatus: status, diff: diff.slice(0, 64000), diffTruncated: diff.length > 64000,
      note: 'Diff excludes untracked file contents; inspect the listed new files in the worktree. Working tree is preserved. No merge, commit, push, deployment, or test was performed by this worker.' };
  }
}

function makePrompt(brief, scope) {
  return `Frontend task from Codex:\n${brief}\n\nAllowed write paths (files or directories):\n${scope.join('\n')}\n\nRead /docs first and relevant project instructions. Preserve design anchors. Work only in this isolated checkout. Report missing context or blocked tool needs. You cannot run shell/tests; Codex will verify. Finish with a concise summary of changes, unfinished work, and checks Codex should run.`;
}
function defaultLaunch(task, store) {
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [workerPath, store.root, task.id, task.runId], { detached: true, windowsHide: true, stdio: 'ignore' });
  const active = store.read('active.json');
  if (child.pid && active?.taskId === task.id && active.runId === task.runId) store.write('active.json', { ...active, pid: child.pid });
  child.on('error', () => {
    const latest = store.task(task.id);
    if (latest.runId !== task.runId) return;
    latest.status = 'failed'; latest.reason = 'Worker process failed to launch.'; store.save(latest); store.release(task.id, task.runId);
  });
  child.unref();
}
