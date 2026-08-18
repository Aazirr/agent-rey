/**
 * Owns every live session: the AgentSession, its EventLog, and the set of
 * clients currently watching it.
 *
 * The registry is the source of truth. Clients attach and detach freely; turns
 * keep running either way. That inversion is the whole reason the daemon is a
 * separate process (docs/decisions.md D-002).
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { PermissionMode, SessionInfo, SessionStatus } from '@agent-rey/shared';
import { isUnattendedMode } from '@agent-rey/shared';
import { AgentSession } from './agent-session.js';
import { EventLog } from './event-log.js';
import type { AuditLog } from './audit-log.js';
import type { Config } from './config.js';
import { isPathAllowed } from './config.js';
import type { Store } from './store.js';

/** Metadata persisted so sessions can be resumed after a daemon restart. */
export interface PersistedSession {
  id: string;
  agentSessionId?: string;
  projectPath: string;
  permissionMode: PermissionMode;
  model?: string;
  title?: string;
  createdAt: number;
  lastActivityAt: number;
  costUsd: number;
  checkpointing: boolean;
  /**
   * Project-relative paths this session has written to, persisted so a session
   * resumed after a daemon restart keeps its diff scope instead of silently
   * falling back to the whole project.
   */
  touchedFiles?: string[];
}

export interface RegistryState {
  sessions: Record<string, PersistedSession>;
}

export type SessionEvent =
  | { t: 'event'; sessionId: string; seq: number; message: unknown }
  | { t: 'session.updated'; session: SessionInfo }
  | { t: 'session.created'; session: SessionInfo }
  | { t: 'session.removed'; sessionId: string };

type Listener = (event: SessionEvent) => void;

interface Entry {
  session: AgentSession;
  log: EventLog;
  meta: PersistedSession;
}

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`Refusing to start another session; the limit is ${limit}. Stop one first.`);
    this.name = 'SessionLimitError';
  }
}

export class ProjectNotAllowedError extends Error {
  constructor(path: string) {
    super(`"${path}" is not inside a configured project root.`);
    this.name = 'ProjectNotAllowedError';
  }
}

export class SessionRegistry {
  #entries = new Map<string, Entry>();
  #listeners = new Set<Listener>();

  constructor(
    private readonly config: Config,
    private readonly store: Store<RegistryState>,
    private readonly audit: AuditLog,
  ) {}

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: SessionEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // A broken client must not stall the session loop.
      }
    }
  }

  /** Live sessions plus persisted-but-not-running ones, newest activity first. */
  list(): SessionInfo[] {
    const infos = new Map<string, SessionInfo>();
    for (const meta of Object.values(this.store.data.sessions)) {
      infos.set(meta.id, this.#toInfo(meta, this.#entries.get(meta.id)));
    }
    for (const [id, entry] of this.#entries) {
      infos.set(id, this.#toInfo(entry.meta, entry));
    }
    return [...infos.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  get(id: string): Entry | undefined {
    return this.#entries.get(id);
  }

  /** Map of projectPath → most recent activity, for ordering the project picker. */
  lastUsedByProject(): Map<string, number> {
    const map = new Map<string, number>();
    for (const meta of Object.values(this.store.data.sessions)) {
      const prev = map.get(meta.projectPath) ?? 0;
      if (meta.lastActivityAt > prev) map.set(meta.projectPath, meta.lastActivityAt);
    }
    return map;
  }

  #toInfo(meta: PersistedSession, entry: Entry | undefined): SessionInfo {
    const status: SessionStatus = entry ? entry.session.status : 'exited';
    return {
      id: meta.id,
      ...(entry?.session.agentSessionId ?? meta.agentSessionId
        ? { agentSessionId: entry?.session.agentSessionId ?? meta.agentSessionId }
        : {}),
      projectPath: meta.projectPath,
      projectName: basename(meta.projectPath),
      permissionMode: entry?.session.permissionMode ?? meta.permissionMode,
      // Prefer the live session: a mid-session setModel must be reflected back or
      // the client's picker snaps to the stale persisted value.
      ...(entry?.session.model ?? meta.model ? { model: entry?.session.model ?? meta.model } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      status,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      lastSeq: entry?.log.lastSeq ?? 0,
      costUsd: entry?.session.costUsd ?? meta.costUsd,
      checkpointing: meta.checkpointing,
    };
  }

  #touch(entry: Entry): void {
    entry.meta.lastActivityAt = Date.now();
    entry.meta.costUsd = entry.session.costUsd;
    entry.meta.permissionMode = entry.session.permissionMode;
    // Persist the live model so a resumed session keeps the one you picked.
    const model = entry.session.model;
    if (model !== undefined) entry.meta.model = model;
    else delete entry.meta.model;
    const agentId = entry.session.agentSessionId;
    if (agentId) entry.meta.agentSessionId = agentId;
    this.store.data.sessions[entry.meta.id] = entry.meta;
  }

  async start(opts: {
    projectPath: string;
    permissionMode: PermissionMode;
    model?: string;
    title?: string;
    prompt?: string;
    forkFromExternalId?: string;
  }): Promise<SessionInfo> {
    if (!isPathAllowed(opts.projectPath, this.config.projectRoots)) {
      throw new ProjectNotAllowedError(opts.projectPath);
    }
    const live = [...this.#entries.values()].filter((e) => e.session.status !== 'exited');
    if (live.length >= this.config.maxConcurrentSessions) {
      throw new SessionLimitError(this.config.maxConcurrentSessions);
    }

    const now = Date.now();
    const model = opts.model ?? this.config.defaultModel;
    const meta: PersistedSession = {
      id: randomUUID(),
      projectPath: opts.projectPath,
      permissionMode: opts.permissionMode,
      ...(model !== undefined ? { model } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      createdAt: now,
      lastActivityAt: now,
      costUsd: 0,
      checkpointing: this.config.enableCheckpointing,
      ...(opts.forkFromExternalId ? { agentSessionId: opts.forkFromExternalId } : {}),
    };

    const entry = this.#instantiate(meta, opts.forkFromExternalId, Boolean(opts.forkFromExternalId));
    this.audit.sessionStart({
      sessionId: meta.id,
      projectPath: meta.projectPath,
      permissionMode: meta.permissionMode,
      ...(meta.model ? { model: meta.model } : {}),
      unattended: isUnattendedMode(meta.permissionMode),
    });

    entry.session.start(opts.prompt);
    this.store.data.sessions[meta.id] = meta;
    this.store.save();

    const info = this.#toInfo(meta, entry);
    this.#emit({ t: 'session.created', session: info });
    return info;
  }

  /**
   * Bring a previously-started session back to life, reusing the agent's own
   * session id so history and context are intact.
   */
  async resume(sessionId: string): Promise<SessionInfo> {
    const existing = this.#entries.get(sessionId);
    if (existing && existing.session.status !== 'exited') return this.#toInfo(existing.meta, existing);

    const meta = this.store.data.sessions[sessionId];
    if (!meta) throw new Error(`unknown session ${sessionId}`);
    if (!isPathAllowed(meta.projectPath, this.config.projectRoots)) {
      throw new ProjectNotAllowedError(meta.projectPath);
    }

    const entry = this.#instantiate(meta, meta.agentSessionId);
    // Continue the seq series rather than restarting at 1, so a client holding
    // an old sinceSeq is not silently served the wrong events.
    await entry.log.restoreLastSeq();
    entry.session.start();

    const info = this.#toInfo(meta, entry);
    this.#emit({ t: 'session.updated', session: info });
    return info;
  }

  #instantiate(meta: PersistedSession, resumeAgentSessionId: string | undefined, forkSession = false): Entry {
    const log = new EventLog(meta.id, this.config.logDir, this.config.eventBufferSize);
    const policy = this.config.projectPolicies[meta.projectPath];

    const entryRef: { current?: Entry } = {};

    const session = new AgentSession({
      id: meta.id,
      projectPath: meta.projectPath,
      permissionMode: meta.permissionMode,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      ...(policy?.disallowedTools?.length ? { disallowedTools: policy.disallowedTools } : {}),
      ...(resumeAgentSessionId ? { resumeAgentSessionId } : {}),
      ...(forkSession ? { forkSession: true } : {}),
      ...(meta.touchedFiles?.length ? { initialTouchedFiles: meta.touchedFiles } : {}),
      enableCheckpointing: this.config.enableCheckpointing,
      sandbox: this.config.sandbox,
      ...(this.config.claudeExecutable ? { claudeExecutable: this.config.claudeExecutable } : {}),
      audit: this.audit,
      onEvent: (message) => {
        const stored = log.append(message);
        const e = entryRef.current;
        if (e) this.#touch(e);
        this.#emit({ t: 'event', sessionId: meta.id, seq: stored.seq, message });
      },
      onStatus: () => {
        const e = entryRef.current;
        if (!e) return;
        this.#touch(e);
        this.#emit({ t: 'session.updated', session: this.#toInfo(e.meta, e) });
      },
      onCost: () => {
        const e = entryRef.current;
        if (e) this.#touch(e);
      },
      onAgentSessionId: (agentSessionId) => {
        meta.agentSessionId = agentSessionId;
        this.store.data.sessions[meta.id] = meta;
        this.store.save();
      },
      onTouchedFile: (relativePath) => {
        // Persisted immediately: the point is to survive a crash, not just a clean
        // shutdown, and writes are rare enough that a save per new file is cheap.
        meta.touchedFiles = [...new Set([...(meta.touchedFiles ?? []), relativePath])];
        this.store.data.sessions[meta.id] = meta;
        this.store.save();
      },
      onError: (err) => {
        // Surface as a synthetic event so the phone shows it in-line rather
        // than the session just going quiet.
        const stored = log.append({ type: 'rey_error', error: err.message });
        this.#emit({ t: 'event', sessionId: meta.id, seq: stored.seq, message: stored.message });
      },
    });

    const entry: Entry = { session, log, meta };
    entryRef.current = entry;
    this.#entries.set(meta.id, entry);
    return entry;
  }

  async stop(sessionId: string, reason = 'client request'): Promise<void> {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    await entry.session.stop();
    await entry.log.close();
    this.#entries.delete(sessionId);
    this.#touch(entry);
    this.store.save();
    this.audit.sessionStop({ sessionId, projectPath: entry.meta.projectPath, reason });
    this.#emit({ t: 'session.updated', session: this.#toInfo(entry.meta, undefined) });
  }

  /**
   * Stop a session if it is running, then forget it entirely.
   *
   * The transcript file is deliberately left on disk — deletion here is about
   * tidying the session list, not destroying the record. Retention pruning
   * removes the file later once the session is no longer resumable.
   */
  async delete(sessionId: string): Promise<boolean> {
    const known = this.#entries.has(sessionId) || this.store.data.sessions[sessionId] !== undefined;
    if (!known) return false;

    if (this.#entries.has(sessionId)) await this.stop(sessionId, 'deleted by client');
    delete this.store.data.sessions[sessionId];
    this.store.save();
    this.#emit({ t: 'session.removed', sessionId });
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.stop(id, 'daemon shutdown')));
  }

  /**
   * Stop sessions that have been idle too long, reclaiming one CLI process each.
   *
   * Only genuinely idle sessions are eligible: a session in `thinking` is doing
   * work, possibly a long unattended task, and must never be reaped out from under
   * itself. Stopping is safe because a stopped session is resumable with its
   * context intact — the phone shows it as stopped and a prompt brings it back.
   */
  async reapIdleSessions(now = Date.now()): Promise<string[]> {
    const timeoutMs = this.config.sessionIdleTimeoutMinutes * 60 * 1000;
    if (timeoutMs <= 0) return [];

    const reaped: string[] = [];
    for (const [id, entry] of [...this.#entries]) {
      if (entry.session.status !== 'idle') continue;
      if (now - entry.meta.lastActivityAt < timeoutMs) continue;
      await this.stop(id, `idle for over ${this.config.sessionIdleTimeoutMinutes} minutes`);
      reaped.push(id);
    }
    return reaped;
  }

  /** Agent session ids Agent Rey owns, so external listings can exclude them. */
  knownAgentSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of Object.values(this.store.data.sessions)) if (m.agentSessionId) ids.add(m.agentSessionId);
    for (const e of this.#entries.values()) { const id = e.session.agentSessionId; if (id) ids.add(id); }
    return ids;
  }

  /** Session ids worth retaining logs for — anything still resumable. */
  knownSessionIds(): Set<string> {
    return new Set(Object.keys(this.store.data.sessions));
  }

  /**
   * Persist and broadcast a session's current state. Needed after mutations that
   * do not change status — setModel and setPermissionMode — because otherwise the
   * client's own control would appear to revert on the next update it receives.
   */
  notifyChanged(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    this.#touch(entry);
    this.store.save();
    this.#emit({ t: 'session.updated', session: this.#toInfo(entry.meta, entry) });
  }

  /** Require a live session, with a message worth showing a user. */
  require(sessionId: string): Entry {
    const entry = this.#entries.get(sessionId);
    if (!entry) {
      const known = this.store.data.sessions[sessionId];
      throw new Error(
        known
          ? `Session ${sessionId} is not running. Resume it first.`
          : `Unknown session ${sessionId}.`,
      );
    }
    return entry;
  }
}
