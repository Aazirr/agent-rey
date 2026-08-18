/**
 * Node-side client for reyd, used by the extension.
 *
 * Separate from the browser client (`packages/web/src/lib/client.ts`) because the
 * extension host has no global `WebSocket` and no `localStorage` — it uses the
 * `ws` package and VSCode's SecretStorage. The protocol handling is intentionally
 * thinner: the extension monitors and controls sessions, it does not render
 * transcripts, so it never needs seq tracking or gap replay.
 *
 * The extension authenticates with the same password flow as the phone. It does
 * NOT get a local-process exemption: "runs on the same machine" is not an identity,
 * and granting one would mean any local process could drive an agent with shell
 * access.
 */

import WebSocket from 'ws';
import type { ClientMessage, ServerMessage, SessionInfo, ProjectInfo, PermissionMode } from '@agent-rey/shared';

/** Kept in sync with the daemon; duplicated to avoid an ESM import in a CJS extension. */
const PROTOCOL_VERSION = 1;

export type ClientStatus = 'offline' | 'connecting' | 'online' | 'unauthenticated';

export interface DaemonClientEvents {
  status: (status: ClientStatus, detail?: string) => void;
  sessions: (sessions: SessionInfo[]) => void;
  error: (message: string) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const DEAD_AFTER_MS = 40_000;

export class DaemonClient {
  #ws: WebSocket | null = null;
  #status: ClientStatus = 'offline';
  #sessions = new Map<string, SessionInfo>();
  #listeners: { [K in keyof DaemonClientEvents]: Set<DaemonClientEvents[K]> } = {
    status: new Set(),
    sessions: new Set(),
    error: new Set(),
  };
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #lastMessageAt = 0;
  #stopped = false;
  #token: string | null = null;

  constructor(private daemonUrl: string) {}

  get status(): ClientStatus {
    return this.#status;
  }

  get sessions(): SessionInfo[] {
    return [...this.#sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  on<K extends keyof DaemonClientEvents>(event: K, handler: DaemonClientEvents[K]): () => void {
    this.#listeners[event].add(handler);
    return () => this.#listeners[event].delete(handler);
  }

  #emit<K extends keyof DaemonClientEvents>(event: K, ...args: Parameters<DaemonClientEvents[K]>): void {
    for (const handler of this.#listeners[event]) {
      try {
        (handler as (...a: Parameters<DaemonClientEvents[K]>) => void)(...args);
      } catch {
        // A misbehaving view must not break the connection loop.
      }
    }
  }

  #setStatus(status: ClientStatus, detail?: string): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit('status', status, detail);
  }

  setDaemonUrl(url: string): void {
    if (url === this.daemonUrl) return;
    this.daemonUrl = url;
    this.reconnect();
  }

  /* --------------------------------- auth ---------------------------------- */

  /** Exchange a password for a device token. Returns the token, or an error message. */
  async login(password: string): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.daemonUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, label: 'VSCode' }),
      });
    } catch {
      return { ok: false, message: `Could not reach the daemon at ${this.daemonUrl}. Is reyd running?` };
    }

    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      token?: string;
      error?: string;
    };

    if (res.ok && body.ok && body.token) return { ok: true, token: body.token };

    switch (body.error) {
      case 'invalid_password':
        return { ok: false, message: 'Wrong password.' };
      case 'locked_out':
        return { ok: false, message: 'Too many failed attempts. Wait and try again.' };
      case 'not_configured':
        return { ok: false, message: 'The daemon has no REY_PASSWORD set, so it refuses all logins.' };
      default:
        return { ok: false, message: `Login failed (${res.status}).` };
    }
  }

  async isDaemonReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.daemonUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ------------------------------- connection ------------------------------ */

  start(token: string): void {
    this.#token = token;
    this.#stopped = false;
    this.#attempt = 0;
    this.#connect();
  }

  #connect(): void {
    if (this.#stopped || !this.#token) return;
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) return;

    this.#setStatus('connecting');
    const ws = new WebSocket(`${this.daemonUrl.replace(/^http/i, 'ws')}/ws`);
    this.#ws = ws;

    ws.on('open', () => {
      this.#send({ t: 'hello', token: this.#token!, protocolVersion: PROTOCOL_VERSION });
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      this.#lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      this.#handle(msg);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.#ws = null;
      this.#stopHeartbeat();
      if (this.#stopped) {
        this.#setStatus('offline');
        return;
      }
      if (code === 4401) {
        // The token is dead; reconnecting cannot fix it.
        this.#setStatus('unauthenticated', reason.toString() || 'token rejected');
        return;
      }
      this.#scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' always follows.
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.#attempt - 1));
    this.#setStatus('offline');
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  reconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#attempt = 0;
    try {
      this.#ws?.close();
    } catch {
      /* already closed */
    }
    this.#ws = null;
    this.#connect();
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#lastMessageAt = Date.now();
    this.#heartbeat = setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Same half-open-socket problem the browser client has: silence, not a
      // close event, is the signal that a connection has died.
      if (Date.now() - this.#lastMessageAt > DEAD_AFTER_MS) {
        try {
          ws.terminate();
        } catch {
          /* already dying */
        }
        return;
      }
      this.#send({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello.ok':
        this.#attempt = 0;
        this.#setStatus('online');
        this.#startHeartbeat();
        this.#replaceSessions(msg.sessions);
        return;
      case 'sessions':
        this.#replaceSessions(msg.sessions);
        return;
      case 'session.created':
      case 'session.updated':
        this.#sessions.set(msg.session.id, msg.session);
        this.#emit('sessions', this.sessions);
        return;
      case 'error':
        // Session-scoped errors are noise here; only surface global ones.
        if (!msg.sessionId) this.#emit('error', msg.message);
        return;
      default:
        return;
    }
  }

  #replaceSessions(sessions: SessionInfo[]): void {
    this.#sessions = new Map(sessions.map((s) => [s.id, s]));
    this.#emit('sessions', this.sessions);
  }

  #send(msg: ClientMessage): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  /* -------------------------------- commands ------------------------------- */

  refresh(): void {
    this.#send({ t: 'sessions.list' });
  }

  requestProjects(): Promise<ProjectInfo[]> {
    return new Promise((resolve) => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve([]);
        return;
      }
      const timer = setTimeout(() => {
        ws.off('message', onMessage);
        resolve([]);
      }, 10_000);

      const onMessage = (raw: WebSocket.RawData): void => {
        try {
          const msg = JSON.parse(raw.toString()) as ServerMessage;
          if (msg.t === 'projects') {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg.projects);
          }
        } catch {
          /* ignore */
        }
      };
      ws.on('message', onMessage);
      this.#send({ t: 'projects.list' });
    });
  }

  startSession(opts: {
    projectPath: string;
    permissionMode: PermissionMode;
    prompt?: string;
  }): void {
    this.#send({ t: 'session.start', ...opts });
  }

  interrupt(sessionId: string): void {
    this.#send({ t: 'session.interrupt', sessionId });
  }

  stopSession(sessionId: string): void {
    this.#send({ t: 'session.stop', sessionId });
  }

  dispose(): void {
    this.#stopped = true;
    this.#stopHeartbeat();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    try {
      this.#ws?.close(1000, 'extension deactivating');
    } catch {
      /* ignore */
    }
    this.#ws = null;
  }
}
