/**
 * Housekeeping the daemon must do because it runs for months at a time.
 *
 * Two unbounded resources existed before this:
 *  - one NDJSON event log per session, forever
 *  - one audit file per day, forever
 *
 * Neither is large individually, and that is exactly why it would have gone
 * unnoticed until a disk filled up. Retention is generous by default: the audit
 * trail is the accountability record for unattended sessions (docs/decisions.md
 * D-004), so it outlives the transcripts.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface PruneResult {
  auditFilesRemoved: number;
  logFilesRemoved: number;
  bytesReclaimed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete audit and event-log files older than their retention windows. Session
 * logs for sessions the registry still knows about are kept regardless of age,
 * so resuming an old session never finds its history already deleted.
 */
export async function pruneOldFiles(opts: {
  auditDir: string;
  logDir: string;
  auditRetentionDays: number;
  logRetentionDays: number;
  /** Session ids to keep no matter how old their log file is. */
  keepSessionIds: ReadonlySet<string>;
  now?: number;
}): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const result: PruneResult = { auditFilesRemoved: 0, logFilesRemoved: 0, bytesReclaimed: 0 };

  if (opts.auditRetentionDays > 0) {
    const cutoff = now - opts.auditRetentionDays * DAY_MS;
    const removed = await pruneDir(opts.auditDir, cutoff, (name) => /^audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name));
    result.auditFilesRemoved = removed.count;
    result.bytesReclaimed += removed.bytes;
  }

  if (opts.logRetentionDays > 0) {
    const cutoff = now - opts.logRetentionDays * DAY_MS;
    const removed = await pruneDir(opts.logDir, cutoff, (name) => {
      if (!name.endsWith('.ndjson')) return false;
      const sessionId = name.slice(0, -'.ndjson'.length);
      // A session still in the registry can be resumed, so keep its transcript.
      return !opts.keepSessionIds.has(sessionId);
    });
    result.logFilesRemoved = removed.count;
    result.bytesReclaimed += removed.bytes;
  }

  return result;
}

async function pruneDir(
  dir: string,
  cutoffMs: number,
  eligible: (name: string) => boolean,
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Directory not created yet; nothing to prune.
    return { count, bytes };
  }

  for (const name of names) {
    if (!eligible(name)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
      await unlink(full);
      count += 1;
      bytes += st.size;
    } catch {
      // A file vanishing or being locked mid-prune is not an error worth raising.
    }
  }

  return { count, bytes };
}
