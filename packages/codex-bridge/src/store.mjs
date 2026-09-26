import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const stateRoot = () => process.env.REY_BRIDGE_STATE_DIR || join(homedir(), '.agent-rey', 'codex-bridge');
export const isAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export class Store {
  constructor(root = stateRoot()) {
    this.root = root;
    for (const dir of ['tasks', 'worktrees', 'probe', 'no-hooks']) mkdirSync(join(root, dir), { recursive: true });
  }
  read(name, fallback = null) {
    const path = join(this.root, name);
    // Corrupt/unreadable state must fail closed, especially the account circuit.
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  }
  write(name, value) {
    const path = join(this.root, name);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  }
  task(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID.');
    const task = this.read(`tasks/${id}.json`);
    if (!task) throw new Error('Unknown task ID.');
    return task;
  }
  save(task) { task.updatedAt = new Date().toISOString(); this.write(`tasks/${task.id}.json`, task); }
  circuit() { return this.read('account.json', { state: 'unknown', reason: 'Not checked yet.' }); }
  trip(failure) {
    this.write('account.json', { state: 'blocked', ...failure, at: new Date().toISOString(), recovery: 'Fix the account in Claude Code, then explicitly run rey_check_account. No tasks are retried automatically.' });
  }
  assertAvailable() {
    const c = this.circuit();
    if (c.state === 'blocked') throw new Error(`Claude delegation blocked (${c.kind}): ${c.reason} Use rey_check_account after fixing the account. Existing work is preserved.`);
  }
  acquire(taskId, runId) {
    // Atomic across all Codex windows and all projects. No queued automatic retries.
    try {
      writeFileSync(join(this.root, 'active.json'), JSON.stringify({ taskId, runId, pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw new Error('A Claude worker is already reserved/running. Inspect rey_status; do not start another.');
    }
  }
  claim(taskId, runId) {
    const active = this.read('active.json');
    if (active?.taskId !== taskId || active.runId !== runId) throw new Error('Worker reservation no longer belongs to this run.');
    this.write('active.json', { ...active, pid: process.pid });
  }
  release(taskId, runId) {
    const active = this.read('active.json');
    if (active?.taskId === taskId && active.runId === runId) unlinkSync(join(this.root, 'active.json'));
  }
  recoverStale() {
    const active = this.read('active.json');
    if (!active || isAlive(active.pid) || Date.now() - active.at < 30000) return;
    // Only remove the exact stale reservation. Never kill a PID or delete a worktree.
    const task = this.task(active.taskId);
    if (task.runId === active.runId && ['starting', 'running'].includes(task.status)) {
      task.status = 'interrupted';
      task.reason = 'Worker process exited without a terminal result. Partial files are preserved; no automatic restart.';
      this.save(task);
    }
    this.release(active.taskId, active.runId);
  }
}

export function loadConfig(store) {
  const c = store.read('config.json', {});
  const roots = c.allowedProjectRoots ?? [join(homedir(), 'Documents')];
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(r => typeof r !== 'string')) throw new Error('Invalid allowedProjectRoots.');
  return {
    allowedProjectRoots: roots,
    maxTurns: bounded(c.maxTurns ?? 24, 1, 60),
    timeoutSeconds: bounded(c.timeoutSeconds ?? 900, 30, 1800),
    model: typeof c.model === 'string' ? c.model : undefined,
  };
}
function bounded(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Config number must be between ${min} and ${max}.`);
  return value;
}

export function classifyFailure(code = '', detail = '', resetAt) {
  const text = `${code} ${detail}`.toLowerCase();
  let kind = 'unavailable';
  let reason = 'Claude failed or disconnected. Check the service/account before trying again.';
  if (/disabled|suspend|deactivat|banned|oauth_org_not_allowed|forbidden|\b403\b/.test(text)) {
    kind = 'account_disabled'; reason = 'Claude account or organization access is disabled/restricted.';
  } else if (/authentication|unauthorized|not logged|log.?in|expired|invalid.*token|\b401\b/.test(text)) {
    kind = 'authentication'; reason = 'Claude sign-in is missing or expired.';
  } else if (/rate_limit|rate limit|usage limit|hit your limit|quota|\b429\b/.test(text)) {
    kind = 'usage_limit'; reason = 'Claude usage/rate limit reached. Wait for reset before checking again.';
  } else if (/billing|credit|payment|balance/.test(text)) {
    kind = 'billing'; reason = 'Claude billing/credit access is unavailable. No API-key fallback was attempted.';
  } else if (/model_not_found|model.*not.*available/.test(text)) {
    kind = 'model'; reason = 'The configured Claude model is unavailable for this account.';
  }
  return { kind, reason, ...(Number.isFinite(resetAt) ? { retryAfter: new Date(resetAt * 1000).toISOString() } : {}) };
}
