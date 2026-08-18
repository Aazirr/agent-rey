/**
 * Append-only audit trail, written regardless of permission mode.
 *
 * This is the accountability half of the D-004 tradeoff: sessions may run
 * unattended, so there must be a durable record of what they did. Kept separate
 * from the per-session event log because it answers a different question — not
 * "what did the conversation look like" but "what did this thing touch".
 *
 * One NDJSON file per day so it can be read with ordinary tools and rotated by
 * deleting old files.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from '@agent-rey/shared';

type AuditEntry =
  | {
      kind: 'tool_use';
      at: string;
      sessionId: string;
      projectPath: string;
      permissionMode: PermissionMode;
      toolName: string;
      /** Truncated; a full Write payload could be megabytes. */
      toolInput: string;
    }
  | {
      kind: 'session_start';
      at: string;
      sessionId: string;
      projectPath: string;
      permissionMode: PermissionMode;
      model?: string;
      unattended: boolean;
    }
  | { kind: 'session_stop'; at: string; sessionId: string; projectPath: string; reason: string }
  | { kind: 'mode_change'; at: string; sessionId: string; projectPath: string; mode: PermissionMode }
  | {
      kind: 'rewind';
      at: string;
      sessionId: string;
      projectPath: string;
      userMessageId: string;
      dryRun: boolean;
    }
  | { kind: 'login'; at: string; outcome: 'success' | 'failure' | 'locked_out'; remote: string; label?: string }
  | { kind: 'device_revoked'; at: string; deviceId: string }
  | { kind: 'stderr'; at: string; sessionId: string; line: string };

const MAX_INPUT_CHARS = 2000;

export class AuditLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  #write(entry: AuditEntry): void {
    const day = entry.at.slice(0, 10);
    try {
      appendFileSync(join(this.dir, `audit-${day}.ndjson`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Never let audit IO take down a session; the console still has it.
    }
  }

  #now(): string {
    return new Date().toISOString();
  }

  toolUse(e: {
    sessionId: string;
    projectPath: string;
    permissionMode: PermissionMode;
    toolName: string;
    toolInput: unknown;
  }): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(e.toolInput) ?? 'undefined';
    } catch {
      serialized = '[unserializable]';
    }
    this.#write({
      kind: 'tool_use',
      at: this.#now(),
      sessionId: e.sessionId,
      projectPath: e.projectPath,
      permissionMode: e.permissionMode,
      toolName: e.toolName,
      toolInput:
        serialized.length > MAX_INPUT_CHARS
          ? `${serialized.slice(0, MAX_INPUT_CHARS)}…[${serialized.length} chars total]`
          : serialized,
    });
  }

  sessionStart(e: {
    sessionId: string;
    projectPath: string;
    permissionMode: PermissionMode;
    model?: string;
    unattended: boolean;
  }): void {
    this.#write({ kind: 'session_start', at: this.#now(), ...e });
  }

  sessionStop(e: { sessionId: string; projectPath: string; reason: string }): void {
    this.#write({ kind: 'session_stop', at: this.#now(), ...e });
  }

  modeChange(e: { sessionId: string; projectPath: string; mode: PermissionMode }): void {
    this.#write({ kind: 'mode_change', at: this.#now(), ...e });
  }

  rewind(e: { sessionId: string; projectPath: string; userMessageId: string; dryRun: boolean }): void {
    this.#write({ kind: 'rewind', at: this.#now(), ...e });
  }

  login(e: { outcome: 'success' | 'failure' | 'locked_out'; remote: string; label?: string }): void {
    this.#write({ kind: 'login', at: this.#now(), ...e });
  }

  deviceRevoked(deviceId: string): void {
    this.#write({ kind: 'device_revoked', at: this.#now(), deviceId });
  }

  stderr(sessionId: string, data: string): void {
    const line = data.trimEnd();
    if (!line) return;
    this.#write({ kind: 'stderr', at: this.#now(), sessionId, line: line.slice(0, MAX_INPUT_CHARS) });
  }
}
