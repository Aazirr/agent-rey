/**
 * Wire protocol between reyd (the local daemon) and its clients (phone PWA,
 * VSCode extension).
 *
 * Design note: agent messages are forwarded verbatim inside `ServerEvent.message`
 * rather than remapped to a bespoke schema. See docs/decisions.md D-006. The
 * daemon only adds the envelope: which session, and a monotonic `seq` for replay.
 */

export const PROTOCOL_VERSION = 1;

/** Mirrors the SDK's PermissionMode. Duplicated so the web bundle need not import the SDK. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** Modes that let a session act without a human answering prompts. */
export const UNATTENDED_MODES: readonly PermissionMode[] = ['acceptEdits', 'bypassPermissions', 'dontAsk'];

export function isUnattendedMode(mode: PermissionMode): boolean {
  return UNATTENDED_MODES.includes(mode);
}

export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'interrupting'
  | 'exited'
  | 'error';

export interface ProjectInfo {
  /** Absolute path; the session's cwd. */
  path: string;
  /** Basename, for display. */
  name: string;
  vcs: 'git' | null;
  /** Current git branch, when resolvable. */
  branch?: string;
  /** Epoch ms of the last Agent Rey session in this project, if any. */
  lastUsedAt?: number;
}

export interface SessionInfo {
  /** Agent Rey's own id. Stable across CLI session resumes. */
  id: string;
  /** The underlying agent session id, once the CLI reports it. */
  agentSessionId?: string;
  projectPath: string;
  projectName: string;
  permissionMode: PermissionMode;
  model?: string;
  title?: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  /** Highest event seq emitted so far; clients resume from here. */
  lastSeq: number;
  /** Cumulative USD cost reported by the agent. */
  costUsd?: number;
  /** True when file checkpointing is on, so rewind is offered. */
  checkpointing: boolean;
}

/**
 * Uncommitted changes in a session's project, as git sees them.
 *
 * With rewind unavailable (see docs/decisions.md D-012), this is how you review
 * what an unattended session did before deciding to keep it.
 */
export interface ProjectDiff {
  available: boolean;
  /** Why there is no diff — not a git repo, git missing, command failed. */
  reason?: string;
  /** Unified patch of tracked changes, including staged ones. */
  patch?: string;
  /** New files git is not tracking; they have no patch but they are new work. */
  untracked?: string[];
  /** True when the patch was clipped at the size cap. */
  truncated?: boolean;
  branch?: string;
  /** Which changes this reflects — what was actually used, not what was asked for. */
  scope?: 'session' | 'project';
  /** Session scope was requested but the session has written nothing yet. */
  scopeFellBack?: boolean;
}

/**
 * A session the CLI knows about that Agent Rey did not start — typically one from
 * the Claude Code VSCode extension or the terminal.
 */
export interface ExternalSession {
  sessionId: string;
  /** The CLI's own summary, or the first prompt, whichever it has. */
  summary?: string;
  lastModified: number;
  gitBranch?: string;
  cwd: string;
}

/** A user turn that files can be rewound to, identified by the CLI's own uuid. */
export interface Checkpoint {
  /** The CLI's message uuid — the only id `rewindFiles` accepts. */
  uuid: string;
  /** First line or so of that user message, for picking one. */
  preview: string;
  /** Position in the session, 1-based, oldest first. */
  index: number;
}

/**
 * Result of rewinding tracked files to a checkpoint. Mirrors the SDK's
 * RewindFilesResult.
 *
 * Note `skippedLinks` is only populated on a real rewind — a dry run's preview
 * counts do not reflect link-safety refusals, so the preview can understate what
 * will be left alone.
 */
export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
}

/** A model the account may select, as reported by the CLI. */
export interface ModelChoice {
  /** The id to pass to session.setModel. */
  value: string;
  label: string;
  description?: string;
}

export interface DeviceSessionInfo {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** Truncated for display; never the full token. */
  userAgent?: string;
  current?: boolean;
}

/* ---------------------------------- client → daemon ---------------------------------- */

export type ClientMessage =
  | { t: 'hello'; token: string; protocolVersion: number }
  | { t: 'projects.list'; refresh?: boolean }
  | { t: 'sessions.list' }
  /** Sessions the CLI knows about in this project that Agent Rey did not start. */
  | { t: 'external.sessions'; projectPath: string }
  | {
      t: 'session.start';
      projectPath: string;
      permissionMode: PermissionMode;
      model?: string;
      title?: string;
      /** Initial prompt, so start+prompt is one round trip. */
      prompt?: string;
      /**
       * Continue a session started elsewhere. It is always FORKED, never taken
       * over — another client may still be driving the original.
       */
      forkFromExternalId?: string;
    }
  | { t: 'session.resume'; sessionId: string }
  | { t: 'session.prompt'; sessionId: string; text: string }
  | { t: 'session.interrupt'; sessionId: string }
  | { t: 'session.setPermissionMode'; sessionId: string; permissionMode: PermissionMode }
  | { t: 'session.setModel'; sessionId: string; model?: string }
  | { t: 'session.stop'; sessionId: string }
  /** Stop the session and forget it entirely. Its transcript file is left on disk. */
  | { t: 'session.delete'; sessionId: string }
  | { t: 'session.rewind'; sessionId: string; userMessageId: string; dryRun?: boolean }
  | { t: 'session.readFile'; sessionId: string; path: string; requestId: string }
  /** Ask the CLI which models this account may use, for the model picker. */
  | { t: 'session.models'; sessionId: string }
  /**
   * List the user turns that can be rewound to. Anchors must come from the CLI's
   * own session history: it assigns its own message uuids and never puts them on
   * the message stream, so an id the daemon minted is not a valid checkpoint key.
   */
  | { t: 'session.checkpoints'; sessionId: string }
  /**
   * Uncommitted changes in the session's project, via git on the daemon.
   * `scope: 'session'` limits it to files this session has written to.
   */
  | { t: 'session.diff'; sessionId: string; scope?: 'session' | 'project' }
  | { t: 'subscribe'; sessionId: string; sinceSeq: number }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'devices.list' }
  | { t: 'devices.revoke'; deviceId: string }
  | { t: 'ping' };

/* ---------------------------------- daemon → client ---------------------------------- */

export type ServerMessage =
  | {
      t: 'hello.ok';
      protocolVersion: number;
      daemonVersion: string;
      deviceId: string;
      sessions: SessionInfo[];
    }
  | { t: 'projects'; projects: ProjectInfo[] }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'external.sessionList'; projectPath: string; sessions: ExternalSession[]; error?: string }
  | { t: 'session.created'; session: SessionInfo }
  | { t: 'session.updated'; session: SessionInfo }
  /** The session is gone. Clients merge `sessions` by id, so removal must be explicit. */
  | { t: 'session.removed'; sessionId: string }
  | {
      /**
       * One agent message. `message` is the SDK's SDKMessage, untouched.
       * `seq` is monotonic per session and gapless — clients detect loss by
       * comparing against the previous seq they saw.
       */
      t: 'event';
      sessionId: string;
      seq: number;
      message: unknown;
    }
  | { t: 'replay.begin'; sessionId: string; fromSeq: number; toSeq: number }
  | {
      t: 'replay.end';
      sessionId: string;
      /** True when the requested sinceSeq had aged out of the log and history is incomplete. */
      truncated: boolean;
    }
  | { t: 'session.rewound'; sessionId: string; dryRun: boolean; result: RewindResult }
  | {
      t: 'session.fileContent';
      requestId: string;
      /** null when the read was refused or the file is missing. */
      content: string | null;
      encoding: 'utf-8' | 'base64';
      /**
       * Set only when the read failed. A clipped-but-successful read reports
       * `truncated` instead — "here is most of it" and "you cannot see this" are
       * different answers and must not render the same way.
       */
      error?: string;
      /** Content was returned but clipped at the size cap. */
      truncated?: boolean;
    }
  | { t: 'session.modelList'; sessionId: string; models: ModelChoice[] }
  | { t: 'session.checkpointList'; sessionId: string; checkpoints: Checkpoint[]; error?: string }
  | { t: 'session.diffResult'; sessionId: string; diff: ProjectDiff }
  | { t: 'devices'; devices: DeviceSessionInfo[] }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode; message: string; sessionId?: string };

export type ErrorCode =
  | 'unauthorized'
  | 'protocol_version'
  | 'bad_request'
  | 'not_found'
  | 'project_not_allowed'
  | 'session_limit'
  | 'tool_denied'
  | 'internal';

/* ---------------------------------- HTTP auth surface ---------------------------------- */

export interface LoginRequest {
  password: string;
  /** Human label for the device list, e.g. "Pixel 9". */
  label?: string;
}

export type LoginResponse =
  | { ok: true; token: string; deviceId: string; expiresAt: number }
  | { ok: false; error: 'invalid_password' | 'locked_out' | 'not_configured'; retryAfterMs?: number };

export interface DaemonInfoResponse {
  daemonVersion: string;
  protocolVersion: number;
  /** False when REY_PASSWORD is unset — the UI shows setup instructions instead of a login form. */
  authConfigured: boolean;
}
