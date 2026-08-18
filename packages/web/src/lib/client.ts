/**
 * WebSocket client for reyd.
 *
 * The reconnect path is the point of this file, not an afterthought. A phone
 * disconnects constantly — screen lock, cellular handoff, tunnel change — and the
 * daemon keeps streaming regardless. So the client tracks the highest `seq` it has
 * seen per session and asks for the gap on every reconnect. Anything less loses
 * turns silently, which is worse than showing an error.
 */

import type {
  ClientMessage,
  ServerMessage,
  SessionInfo,
  ProjectInfo,
  DeviceSessionInfo,
  ModelChoice,
  RewindResult,
  Checkpoint,
  ProjectDiff,
  ExternalSession,
} from '@agent-rey/shared';
import { PROTOCOL_VERSION } from '@agent-rey/shared';
import { wsUrlFor } from './daemon-url.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'failed';

export interface ClientEvents {
  connection: (state: ConnectionState, detail?: string) => void;
  sessions: (sessions: SessionInfo[]) => void;
  /**
   * Fires only for a session this client just started. Distinct from `sessions`
   * because "the session I created" is not the same as "the most recently active
   * session" — another session mid-turn has newer activity and would win a sort.
   */
  sessionCreated: (session: SessionInfo) => void;
  sessionRemoved: (sessionId: string) => void;
  projects: (projects: ProjectInfo[]) => void;
  devices: (devices: DeviceSessionInfo[]) => void;
  sessionEvent: (sessionId: string, seq: number, message: unknown) => void;
  replay: (sessionId: string, phase: 'begin' | 'end', detail: { truncated?: boolean }) => void;
  error: (code: string, message: string) => void;
  fileContent: (requestId: string, content: string | null, error?: string, truncated?: boolean) => void;
  models: (sessionId: string, models: ModelChoice[]) => void;
  rewound: (sessionId: string, dryRun: boolean, result: RewindResult) => void;
  checkpoints: (sessionId: string, checkpoints: Checkpoint[], error?: string) => void;
  diff: (sessionId: string, diff: ProjectDiff) => void;
  externalSessions: (projectPath: string, sessions: ExternalSession[], error?: string) => void;
}

type Handler<K extends keyof ClientEvents> = ClientEvents[K];

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * Liveness. A phone that loses signal often does NOT get a clean WebSocket close
 * — the socket sits half-open and `onclose` never fires, so without this the UI
 * would keep claiming it is connected while nothing arrives. The browser
 * WebSocket API exposes no protocol-level pong, so liveness is application level:
 * send `ping` on an idle interval and treat prolonged silence as death.
 */
const PING_INTERVAL_MS = 10_000;
const DEAD_AFTER_MS = 25_000;

export class ReyClient {
  #ws: WebSocket | null = null;
  #state: ConnectionState = 'idle';
  #listeners = new Map<keyof ClientEvents, Set<Handler<never>>>();
  /** Highest seq applied per session — the basis of gapless reconnect. */
  #lastSeq = new Map<string, number>();
  #subscribed = new Set<string>();
  #attempt = 0;
  #reconnectTimer: number | null = null;
  #closedByUs = false;
  #queue: ClientMessage[] = [];
  #heartbeatTimer: number | null = null;
  #lastMessageAt = 0;

  constructor(
    private daemonUrl: string,
    private token: string,
  ) {}

  get state(): ConnectionState {
    return this.#state;
  }

  on<K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  #emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (...a: Parameters<ClientEvents[K]>) => void)(...args);
      } catch (err) {
        console.error(`listener for ${String(event)} threw`, err);
      }
    }
  }

  #setState(state: ConnectionState, detail?: string): void {
    this.#state = state;
    this.#emit('connection', state, detail);
  }

  /* --------------------------------- lifecycle -------------------------------- */

  connect(): void {
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.#closedByUs = false;
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(wsUrlFor(this.daemonUrl));
    this.#ws = ws;

    ws.onopen = () => {
      this.#send({ t: 'hello', token: this.token, protocolVersion: PROTOCOL_VERSION });
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      // Any inbound frame proves the socket is alive, including a pong.
      this.#lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.#handle(msg);
    };

    ws.onclose = (ev) => {
      this.#ws = null;
      this.#stopHeartbeat();
      if (this.#closedByUs) {
        this.#setState('idle');
        return;
      }
      // 4401 means the token is dead; retrying cannot help.
      if (ev.code === 4401) {
        this.#setState('unauthorized', ev.reason || 'session expired');
        return;
      }
      this.#scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };

    ws.onerror = () => {
      // onclose always follows; state transitions happen there.
    };
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#lastMessageAt = Date.now();
    this.#heartbeatTimer = setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this.#lastMessageAt > DEAD_AFTER_MS) {
        // Half-open socket: nothing has arrived, not even a pong. Tear it down
        // ourselves so the close handler drives a reconnect.
        this.#stopHeartbeat();
        try {
          ws.close(4000, 'no response from daemon');
        } catch {
          /* already dying */
        }
        // Some half-open sockets never fire onclose; force the transition.
        if (this.#ws === ws) {
          this.#ws = null;
          this.#scheduleReconnect('no response from daemon');
        }
        return;
      }

      try {
        ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMessage));
      } catch {
        /* the close handler will pick this up */
      }
    }, PING_INTERVAL_MS) as unknown as number;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #scheduleReconnect(detail: string): void {
    this.#attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.#attempt - 1));
    // Jitter so a flapping tunnel does not produce synchronized retry storms.
    const jittered = delay * (0.7 + Math.random() * 0.6);
    this.#setState('reconnecting', detail);
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.connect(), jittered) as unknown as number;
  }

  /** Call on visibilitychange/online: skip the backoff when the user is looking. */
  reconnectNow(): void {
    if (this.#state === 'open' || this.#state === 'unauthorized') return;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#attempt = 0;
    this.connect();
  }

  disconnect(): void {
    this.#closedByUs = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopHeartbeat();
    this.#ws?.close(1000, 'client closing');
    this.#ws = null;
  }

  /* ---------------------------------- routing --------------------------------- */

  #handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello.ok': {
        this.#attempt = 0;
        this.#setState('open');
        this.#startHeartbeat();
        this.#emit('sessions', msg.sessions);
        // Re-subscribe with the seq we already have, so the daemon replays only
        // the gap rather than the whole history.
        for (const sessionId of this.#subscribed) {
          this.#send({ t: 'subscribe', sessionId, sinceSeq: this.#lastSeq.get(sessionId) ?? 0 });
        }
        const queued = this.#queue;
        this.#queue = [];
        for (const q of queued) this.#send(q);
        return;
      }
      case 'sessions':
        this.#emit('sessions', msg.sessions);
        return;
      case 'session.created':
        this.#emit('sessions', [msg.session]);
        this.#emit('sessionCreated', msg.session);
        return;
      case 'session.updated':
        this.#emit('sessions', [msg.session]);
        return;
      case 'session.removed':
        this.#lastSeq.delete(msg.sessionId);
        this.#subscribed.delete(msg.sessionId);
        this.#emit('sessionRemoved', msg.sessionId);
        return;
      case 'projects':
        this.#emit('projects', msg.projects);
        return;
      case 'devices':
        this.#emit('devices', msg.devices);
        return;
      case 'event': {
        const prev = this.#lastSeq.get(msg.sessionId) ?? 0;
        // Ignore replays of events already applied — reconnects can overlap.
        if (msg.seq <= prev) return;
        this.#lastSeq.set(msg.sessionId, msg.seq);
        this.#emit('sessionEvent', msg.sessionId, msg.seq, msg.message);
        return;
      }
      case 'replay.begin':
        this.#emit('replay', msg.sessionId, 'begin', {});
        return;
      case 'replay.end':
        this.#emit('replay', msg.sessionId, 'end', { truncated: msg.truncated });
        return;
      case 'session.fileContent':
        this.#emit('fileContent', msg.requestId, msg.content, msg.error, msg.truncated);
        return;
      case 'session.modelList':
        this.#emit('models', msg.sessionId, msg.models);
        return;
      case 'session.checkpointList':
        this.#emit('checkpoints', msg.sessionId, msg.checkpoints, msg.error);
        return;
      case 'external.sessionList':
        this.#emit('externalSessions', msg.projectPath, msg.sessions, msg.error);
        return;
      case 'session.diffResult':
        this.#emit('diff', msg.sessionId, msg.diff);
        return;
      case 'session.rewound':
        this.#emit('rewound', msg.sessionId, msg.dryRun, msg.result);
        return;
      case 'pong':
        return;
      case 'error':
        this.#emit('error', msg.code, msg.message);
        return;
      default:
        return;
    }
  }

  #send(msg: ClientMessage): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Anything but hello is buffered until the socket is authenticated again.
      if (msg.t !== 'hello') this.#queue.push(msg);
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  /* ---------------------------------- commands -------------------------------- */

  listProjects(refresh = false): void {
    this.#send(refresh ? { t: 'projects.list', refresh: true } : { t: 'projects.list' });
  }

  /** Sessions the CLI knows about here that Agent Rey did not start. */
  listExternalSessions(projectPath: string): Promise<{ sessions: ExternalSession[]; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve({ sessions: [], error: 'The daemon did not answer in time.' }); }, 30_000);
      const off = this.on('externalSessions', (path, sessions, error) => {
        if (path !== projectPath) return;
        clearTimeout(timer); off();
        resolve(error !== undefined ? { sessions, error } : { sessions });
      });
      this.#send({ t: 'external.sessions', projectPath });
    });
  }

  listSessions(): void {
    this.#send({ t: 'sessions.list' });
  }

  listDevices(): void {
    this.#send({ t: 'devices.list' });
  }

  revokeDevice(deviceId: string): void {
    this.#send({ t: 'devices.revoke', deviceId });
  }

  startSession(opts: Omit<Extract<ClientMessage, { t: 'session.start' }>, 't'>): void {
    this.#send({ t: 'session.start', ...opts });
  }

  resumeSession(sessionId: string): void {
    this.#send({ t: 'session.resume', sessionId });
  }

  prompt(sessionId: string, text: string): void {
    this.#send({ t: 'session.prompt', sessionId, text });
  }

  interrupt(sessionId: string): void {
    this.#send({ t: 'session.interrupt', sessionId });
  }

  setPermissionMode(sessionId: string, permissionMode: Extract<ClientMessage, { t: 'session.setPermissionMode' }>['permissionMode']): void {
    this.#send({ t: 'session.setPermissionMode', sessionId, permissionMode });
  }

  /** Pass undefined to fall back to the daemon's configured default. */
  setModel(sessionId: string, model?: string): void {
    this.#send(model === undefined ? { t: 'session.setModel', sessionId } : { t: 'session.setModel', sessionId, model });
  }

  deleteSession(sessionId: string): void {
    this.#send({ t: 'session.delete', sessionId });
  }

  stopSession(sessionId: string): void {
    this.#send({ t: 'session.stop', sessionId });
  }

  /**
   * Rewind tracked files to a checkpoint. Resolves with the outcome rather than
   * rejecting — "cannot rewind" is a normal answer the UI must render.
   */
  rewind(sessionId: string, userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve({ canRewind: false, error: 'The daemon did not answer in time.' });
      }, 60_000);

      const off = this.on('rewound', (id, wasDryRun, result) => {
        // Match on dryRun too: a preview and a real rewind are distinct answers
        // and can be in flight close together.
        if (id !== sessionId || wasDryRun !== dryRun) return;
        clearTimeout(timer);
        off();
        resolve(result);
      });

      this.#send({ t: 'session.rewind', sessionId, userMessageId, dryRun });
    });
  }

  listModels(sessionId: string): void {
    this.#send({ t: 'session.models', sessionId });
  }

  /** Uncommitted changes in the session's project, as git sees them. */
  fetchDiff(sessionId: string, scope: 'session' | 'project' = 'session'): Promise<ProjectDiff> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve({ available: false, reason: 'The daemon did not answer in time.' });
      }, 40_000);

      const off = this.on('diff', (id, diff) => {
        if (id !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(diff);
      });

      this.#send({ t: 'session.diff', sessionId, scope });
    });
  }

  /** Rewind anchors, read from the CLI's own session history. */
  listCheckpoints(sessionId: string): Promise<{ checkpoints: Checkpoint[]; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve({ checkpoints: [], error: 'The daemon did not answer in time.' });
      }, 30_000);

      const off = this.on('checkpoints', (id, checkpoints, error) => {
        if (id !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(error !== undefined ? { checkpoints, error } : { checkpoints });
      });

      this.#send({ t: 'session.checkpoints', sessionId });
    });
  }

  /**
   * Request a file's contents. Resolves with the daemon's answer, or an error
   * string — never rejects, because a refused read is a normal outcome here.
   */
  readFile(
    sessionId: string,
    path: string,
  ): Promise<{ content: string | null; error?: string; truncated?: boolean }> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve({ content: null, error: 'The daemon did not answer in time.' });
      }, 20_000);

      const off = this.on('fileContent', (id, content, error, truncated) => {
        if (id !== requestId) return;
        clearTimeout(timer);
        off();
        resolve({
          content,
          ...(error !== undefined ? { error } : {}),
          ...(truncated ? { truncated: true } : {}),
        });
      });

      this.#send({ t: 'session.readFile', sessionId, path, requestId });
    });
  }

  subscribe(sessionId: string): void {
    this.#subscribed.add(sessionId);
    this.#send({ t: 'subscribe', sessionId, sinceSeq: this.#lastSeq.get(sessionId) ?? 0 });
  }

  unsubscribe(sessionId: string): void {
    this.#subscribed.delete(sessionId);
    this.#send({ t: 'unsubscribe', sessionId });
  }

  /** Forget cached seq for a session, forcing a full replay next subscribe. */
  resetSeq(sessionId: string): void {
    this.#lastSeq.delete(sessionId);
  }
}
