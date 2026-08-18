/**
 * Tiny synchronous JSON store for small state that must survive restarts
 * (auth devices, session registry metadata).
 *
 * Synchronous on purpose: these files are a few KB, writes are rare, and
 * sync writes remove a whole class of interleaving bugs. Writes are atomic
 * via write-temp-then-rename so a crash mid-save cannot truncate the file.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store<T extends object> {
  #data: T;

  constructor(
    private readonly filePath: string,
    defaults: () => T,
    /** 0o600 for anything containing secrets. */
    private readonly mode = 0o600,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        // Merge over defaults so a state file written by an older version
        // gains new fields instead of surfacing them as undefined.
        this.#data = { ...defaults(), ...(JSON.parse(raw) as T) };
      } catch (err) {
        // A corrupt state file must not prevent the daemon from booting —
        // but we keep the bad file for inspection rather than silently losing it.
        const backup = `${filePath}.corrupt-${process.pid}`;
        try {
          renameSync(filePath, backup);
          process.emitWarning(
            `Could not parse ${filePath} (${(err as Error).message}); moved to ${backup} and starting fresh.`,
          );
        } catch {
          process.emitWarning(`Could not parse or move ${filePath}; starting fresh in memory.`);
        }
        this.#data = defaults();
      }
    } else {
      this.#data = defaults();
      this.save();
    }
  }

  get data(): T {
    return this.#data;
  }

  save(): void {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, { mode: this.mode });
    renameSync(tmp, this.filePath);
    try {
      // rename preserves the temp file's mode, but be explicit in case the
      // destination already existed with looser permissions.
      chmodSync(this.filePath, this.mode);
    } catch {
      // Best effort: POSIX modes are advisory on Windows.
    }
  }
}
