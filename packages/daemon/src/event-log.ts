/**
 * Per-session event log: monotonic seq, in-memory ring buffer, append-only disk
 * mirror.
 *
 * This exists because the phone will disconnect mid-turn on every real use —
 * screen lock, tunnel change, cellular handoff. The daemon keeps streaming
 * regardless and the client asks for the gap on reconnect. Without it the
 * product is a demo. See docs/mvp-scope.md P3.
 *
 * Disk mirror is NDJSON, one `{seq, message}` per line. It backstops the ring
 * buffer for long absences and survives a daemon restart.
 */

import { createWriteStream, mkdirSync, createReadStream, existsSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface LoggedEvent {
  seq: number;
  message: unknown;
}

export interface ReplaySlice {
  events: LoggedEvent[];
  /** True when events before the requested seq were unavailable. */
  truncated: boolean;
}

export class EventLog {
  #buffer: LoggedEvent[] = [];
  #lastSeq = 0;
  #stream: WriteStream | null = null;
  readonly #filePath: string;
  #pendingWrites = 0;
  #closed = false;

  constructor(
    readonly sessionId: string,
    logDir: string,
    private readonly capacity = 2000,
  ) {
    mkdirSync(logDir, { recursive: true });
    this.#filePath = join(logDir, `${sessionId}.ndjson`);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get oldestBufferedSeq(): number {
    return this.#buffer.length > 0 ? this.#buffer[0]!.seq : this.#lastSeq + 1;
  }

  /** Assigns the next seq, buffers, and mirrors to disk. Returns the stored event. */
  append(message: unknown): LoggedEvent {
    if (this.#closed) throw new Error(`EventLog for ${this.sessionId} is closed`);
    const event: LoggedEvent = { seq: ++this.#lastSeq, message };

    this.#buffer.push(event);
    if (this.#buffer.length > this.capacity) {
      this.#buffer.splice(0, this.#buffer.length - this.capacity);
    }

    this.#write(event);
    return event;
  }

  #write(event: LoggedEvent): void {
    this.#stream ??= createWriteStream(this.#filePath, { flags: 'a' });
    this.#pendingWrites += 1;
    this.#stream.write(`${JSON.stringify(event)}\n`, () => {
      this.#pendingWrites -= 1;
    });
  }

  /**
   * Events strictly after `sinceSeq`. Served from the ring buffer when possible,
   * otherwise re-read from disk. `truncated` tells the client its history has a
   * hole so it can show that honestly rather than implying continuity.
   */
  async slice(sinceSeq: number): Promise<ReplaySlice> {
    if (sinceSeq >= this.#lastSeq) return { events: [], truncated: false };

    const oldestBuffered = this.oldestBufferedSeq;
    if (sinceSeq + 1 >= oldestBuffered) {
      return { events: this.#buffer.filter((e) => e.seq > sinceSeq), truncated: false };
    }

    // Gap predates the ring buffer — fall back to the disk mirror.
    const fromDisk = await this.#readFromDisk(sinceSeq);
    if (fromDisk === null) {
      return { events: this.#buffer.filter((e) => e.seq > sinceSeq), truncated: true };
    }
    const firstSeq = fromDisk[0]?.seq ?? sinceSeq + 1;
    return { events: fromDisk, truncated: firstSeq > sinceSeq + 1 };
  }

  async #readFromDisk(sinceSeq: number): Promise<LoggedEvent[] | null> {
    if (!existsSync(this.#filePath)) return null;
    const out: LoggedEvent[] = [];
    const rl = createInterface({
      input: createReadStream(this.#filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as LoggedEvent;
          if (typeof parsed.seq === 'number' && parsed.seq > sinceSeq) out.push(parsed);
        } catch {
          // A torn final line is expected if we crashed mid-write; skip it.
        }
      }
    } finally {
      rl.close();
    }
    return out;
  }

  /** Rehydrate seq after a daemon restart so a resumed session keeps counting up. */
  async restoreLastSeq(): Promise<void> {
    if (!existsSync(this.#filePath)) return;
    const all = await this.#readFromDisk(0);
    if (!all || all.length === 0) return;
    this.#lastSeq = Math.max(...all.map((e) => e.seq));
    this.#buffer = all.slice(-this.capacity);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const stream = this.#stream;
    this.#stream = null;
    if (!stream) return;
    await new Promise<void>((res) => stream.end(res));
  }

  /** Test/diagnostic hook: are all appends flushed to the OS? */
  get flushed(): boolean {
    return this.#pendingWrites === 0;
  }
}
