import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, loadConfig, classifyFailure } from './store.mjs';
import { runClaude } from './claude.mjs';

export async function executeWorker(store, id, runId, runner = runClaude) {
  const task = store.task(id);
  if (task.runId !== runId) throw new Error('Stale worker launch.');
  store.claim(id, runId);
  const abort = new AbortController();
  const config = loadConfig(store);
  const timeout = setTimeout(() => abort.abort(), (task.kind === 'probe' ? 60 : config.timeoutSeconds) * 1000);
  const cancelFile = join(store.root, 'tasks', `${id}.${runId}.cancel`);
  const watch = setInterval(() => { if (existsSync(cancelFile)) abort.abort(); }, 250);
  task.status = 'running'; task.workerPid = process.pid; store.save(task);
  try {
    if (task.kind !== 'probe') store.assertAvailable();
    if (existsSync(cancelFile)) abort.abort();
    const output = await runner(task, config, { signal: abort.signal, onUpdate: update => { Object.assign(task, update); store.save(task); } });
    Object.assign(task, output);
    if (task.status === 'blocked') store.trip(task.failure);
    if (task.kind === 'probe' && task.status === 'completed') {
      if (task.result?.trim() === 'REY_ACCOUNT_OK') store.write('account.json', { state: 'ready', checkedAt: new Date().toISOString(), reason: 'A tools-disabled Claude request succeeded. This is not a guarantee of future access.' });
      else { task.status = 'blocked'; task.failure = classifyFailure('unavailable', 'Unexpected probe response'); store.trip(task.failure); }
    }
    task.completedAt = new Date().toISOString(); store.save(task);
  } catch (e) {
    task.status = 'blocked'; task.failure = classifyFailure('', String(e.message));
    store.trip(task.failure); store.save(task);
  } finally {
    clearTimeout(timeout); clearInterval(watch); store.release(id, runId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , root, id, runId] = process.argv;
  executeWorker(new Store(root), id, runId).catch(() => { process.exitCode = 1; });
}
