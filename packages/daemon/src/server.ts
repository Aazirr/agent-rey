/**
 * HTTP + WebSocket surface.
 *
 * HTTP carries only auth and metadata (login, daemon info, health) plus the
 * optional self-hosted PWA. Everything session-related is WebSocket, because the
 * interesting traffic is a server-push stream.
 *
 * Auth happens twice by design: the HTTP login exchanges REY_PASSWORD for a
 * device token, and the WebSocket refuses to do anything until its first frame
 * presents that token. A socket that never says `hello` can only be closed.
 */

import { createServer, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pruneOldFiles } from './maintenance.js';
import { gitDiff } from './git-diff.js';
import { listExternalSessions } from './external-sessions.js';
import { isPathAllowed } from './config.js';
import type {
  ClientMessage,
  ServerMessage,
  ErrorCode,
  LoginRequest,
  PermissionMode,
  RewindResult,
} from '@agent-rey/shared';
import { PROTOCOL_VERSION } from '@agent-rey/shared';
import type { Auth } from './auth.js';
import type { AuditLog } from './audit-log.js';
import type { Config } from './config.js';
import type { SessionRegistry } from './session-registry.js';
import type { ProjectScanner } from './projects.js';

const DAEMON_VERSION = '0.1.0';
const MAX_BODY_BYTES = 16 * 1024;
/** A socket that has not authenticated within this window is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
/** Idle-session reaping and file pruning; neither is urgent enough to be frequent. */
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

const VALID_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

interface ClientState {
  ws: WebSocket;
  deviceId: string;
  authed: boolean;
  /** Sessions this client wants events for. */
  subscriptions: Set<string>;
  alive: boolean;
}

export interface ServerDeps {
  config: Config;
  auth: Auth;
  audit: AuditLog;
  registry: SessionRegistry;
  scanner: ProjectScanner;
  webRoot?: string;
  log: (msg: string) => void;
}

export class ReyServer {
  #http = createServer((req, res) => void this.#handleHttp(req, res));
  #wss = new WebSocketServer({ noServer: true });
  #clients = new Set<ClientState>();
  #timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: ServerDeps) {
    this.#http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!this.#originAllowed(req.headers.origin, req.headers)) {
        this.deps.log(`Rejected WebSocket from disallowed origin: ${req.headers.origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
    });

    // Fan out session events to whoever is subscribed.
    this.deps.registry.onEvent((event) => {
      if (event.t === 'event') {
        this.#broadcast(
          { t: 'event', sessionId: event.sessionId, seq: event.seq, message: event.message },
          (c) => c.subscriptions.has(event.sessionId),
        );
      } else {
        this.#broadcast(event);
      }
    });
  }

  /* ------------------------------- lifecycle ------------------------------- */

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.deps.config.port, this.deps.config.host, () => {
        this.#http.removeListener('error', reject);
        resolve();
      });
    });
  }

  start(): void {
    this.#timers.push(
      setInterval(() => this.#heartbeat(), PING_INTERVAL_MS),
      setInterval(() => this.deps.auth.pruneExpired(), 60 * 60 * 1000),
      setInterval(() => void this.#maintenance(), MAINTENANCE_INTERVAL_MS),
    );
    // Run once shortly after boot so a long-running daemon is not the only way
    // housekeeping ever happens.
    const initial = setTimeout(() => void this.#maintenance(), 60_000);
    this.#timers.push(initial as unknown as NodeJS.Timeout);
  }

  /** Reap idle sessions and prune old files. Failures are logged, never fatal. */
  async #maintenance(): Promise<void> {
    const { registry, config, log } = this.deps;
    try {
      const reaped = await registry.reapIdleSessions();
      if (reaped.length > 0) {
        log(`stopped ${reaped.length} idle session(s) after ${config.sessionIdleTimeoutMinutes}m`);
      }
    } catch (err) {
      log(`idle reap failed: ${(err as Error).message}`);
    }

    try {
      const pruned = await pruneOldFiles({
        auditDir: join(config.stateDir, 'audit'),
        logDir: config.logDir,
        auditRetentionDays: config.auditRetentionDays,
        logRetentionDays: config.logRetentionDays,
        keepSessionIds: registry.knownSessionIds(),
      });
      if (pruned.auditFilesRemoved > 0 || pruned.logFilesRemoved > 0) {
        log(
          `pruned ${pruned.auditFilesRemoved} audit and ${pruned.logFilesRemoved} log file(s), ` +
            `reclaiming ${(pruned.bytesReclaimed / 1024).toFixed(0)} KB`,
        );
      }
    } catch (err) {
      log(`prune failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const client of this.#clients) client.ws.close(1001, 'daemon shutting down');
    await new Promise<void>((res) => this.#wss.close(() => res()));
    await new Promise<void>((res) => this.#http.close(() => res()));
  }

  #heartbeat(): void {
    for (const client of this.#clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.#clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  /* --------------------------------- origins -------------------------------- */

  /**
   * The PWA may be served from Vercel, so cross-origin sockets are expected —
   * but only from origins the operator listed. Browsers do not enforce
   * same-origin on WebSockets, so this check is ours to make.
   *
   * Same-origin is always allowed: when the daemon serves the PWA itself, the
   * page's origin is whatever hostname the browser used to reach us, which the
   * operator has no reason to have configured. Requiring that would mean the
   * daemon refusing connections from the very page it just served — which is
   * exactly what it did when first put behind `tailscale serve`.
   *
   * `X-Forwarded-Host` is honoured because a reverse proxy (tailscale serve) may
   * rewrite `Host` to the loopback address it forwards to, losing the name the
   * browser actually used.
   */
  #originAllowed(origin: string | undefined, headers: IncomingHttpHeaders = {}): boolean {
    if (!origin) return true; // Non-browser clients (VSCode extension, wscat) send none.
    const normalized = origin.replace(/\/$/, '');
    if (this.deps.config.allowedOrigins.includes(normalized)) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(normalized)) return true;

    let originHost: string;
    try {
      originHost = new URL(normalized).host.toLowerCase();
    } catch {
      return false;
    }

    const forwarded = headers['x-forwarded-host'];
    const candidates = [headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded]
      .filter((h): h is string => typeof h === 'string' && h.length > 0)
      // A forwarded header may carry a comma-separated chain; the first is the
      // hostname the client actually asked for.
      .map((h) => h.split(',')[0]!.trim().toLowerCase());

    return candidates.includes(originHost);
  }

  /* ---------------------------------- HTTP ---------------------------------- */

  #cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && this.#originAllowed(origin, req.headers)) {
      res.setHeader('Access-Control-Allow-Origin', origin.replace(/\/$/, ''));
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    this.#cors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (url.pathname === '/health') {
        json(res, 200, { ok: true, version: DAEMON_VERSION });
        return;
      }

      if (url.pathname === '/api/info') {
        json(res, 200, {
          daemonVersion: DAEMON_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          authConfigured: this.deps.auth.configured,
        });
        return;
      }

      if (url.pathname === '/api/login') {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        await this.#handleLogin(req, res);
        return;
      }

      if (this.deps.webRoot) {
        const served = await this.#serveStatic(url.pathname, res);
        if (served) return;
      }

      json(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      this.deps.log(`HTTP error on ${url.pathname}: ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' });
    }
  }

  async #handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    let body: LoginRequest;
    try {
      body = JSON.parse(await readBody(req)) as LoginRequest;
    } catch {
      json(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    if (typeof body?.password !== 'string' || body.password.length === 0) {
      json(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    const result = this.deps.auth.login({
      password: body.password,
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
      remoteKey: remote,
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
    });

    if (result.ok) {
      this.deps.audit.login({ outcome: 'success', remote, ...(body.label ? { label: body.label } : {}) });
      json(res, 200, result);
      return;
    }

    this.deps.audit.login({
      outcome: result.error === 'locked_out' ? 'locked_out' : 'failure',
      remote,
    });
    // 401 for a wrong password, 429 when throttled, 503 when unconfigured.
    const status = result.error === 'locked_out' ? 429 : result.error === 'not_configured' ? 503 : 401;
    if (result.error === 'locked_out' && result.retryAfterMs) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
    }
    json(res, status, result);
  }

  async #serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const root = this.deps.webRoot;
    if (!root) return false;

    // Resolve inside the web root only; never let a request escape it.
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    if (rel.includes('..')) return false;

    let filePath = join(root, rel || 'index.html');
    if (!existsSync(filePath) || rel === '') filePath = join(root, 'index.html');
    // SPA fallback: unknown non-asset routes render the app shell.
    if (!existsSync(filePath)) {
      if (extname(rel)) return false;
      filePath = join(root, 'index.html');
      if (!existsSync(filePath)) return false;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      // The app shell must never be cached stale; hashed assets can be.
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
    return true;
  }

  /* --------------------------------- sockets -------------------------------- */

  #onConnection(ws: WebSocket): void {
    const client: ClientState = {
      ws,
      deviceId: '',
      authed: false,
      subscriptions: new Set(),
      alive: true,
    };
    this.#clients.add(client);

    const helloTimer = setTimeout(() => {
      if (!client.authed) ws.close(4401, 'authentication timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('message', (raw) => {
      void this.#onMessage(client, raw.toString()).catch((err: unknown) => {
        this.#send(client, {
          t: 'error',
          code: 'internal',
          message: (err as Error).message,
        });
      });
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.#clients.delete(client);
    });

    ws.on('error', () => {
      clearTimeout(helloTimer);
      this.#clients.delete(client);
    });
  }

  async #onMessage(client: ClientState, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.#fail(client, 'bad_request', 'malformed JSON');
      return;
    }

    if (msg.t === 'hello') {
      this.#onHello(client, msg);
      return;
    }

    if (!client.authed) {
      this.#fail(client, 'unauthorized', 'send hello first');
      client.ws.close(4401, 'unauthorized');
      return;
    }

    const { registry, scanner, auth, audit } = this.deps;

    switch (msg.t) {
      case 'ping':
        this.#send(client, { t: 'pong' });
        return;

      case 'projects.list': {
        const projects = await scanner.list({
          ...(msg.refresh ? { refresh: true } : {}),
          lastUsed: registry.lastUsedByProject(),
        });
        this.#send(client, { t: 'projects', projects });
        return;
      }

      case 'sessions.list':
        this.#send(client, { t: 'sessions', sessions: registry.list() });
        return;

      case 'external.sessions': {
        // Containment still applies: this reads the CLI's store, but only for a
        // project the daemon is configured to work in.
        if (!isPathAllowed(msg.projectPath, this.deps.config.projectRoots)) {
          this.#fail(client, 'project_not_allowed', `"${msg.projectPath}" is not inside a configured root.`);
          return;
        }
        try {
          const sessions = await listExternalSessions({
            projectPath: msg.projectPath,
            knownAgentSessionIds: registry.knownAgentSessionIds(),
          });
          this.#send(client, { t: 'external.sessionList', projectPath: msg.projectPath, sessions });
        } catch (err) {
          this.#send(client, {
            t: 'external.sessionList',
            projectPath: msg.projectPath,
            sessions: [],
            error: (err as Error).message,
          });
        }
        return;
      }

      case 'session.start': {
        if (!VALID_MODES.includes(msg.permissionMode)) {
          this.#fail(client, 'bad_request', `unknown permission mode "${msg.permissionMode}"`);
          return;
        }
        try {
          const session = await registry.start({
            projectPath: msg.projectPath,
            permissionMode: msg.permissionMode,
            ...(msg.model ? { model: msg.model } : {}),
            ...(msg.title ? { title: msg.title } : {}),
            ...(msg.prompt ? { prompt: msg.prompt } : {}),
            ...(msg.forkFromExternalId ? { forkFromExternalId: msg.forkFromExternalId } : {}),
          });
          // Auto-subscribe the starter; it always wants the stream it just began.
          client.subscriptions.add(session.id);
          this.#send(client, { t: 'session.created', session });
          // Replay from 0. Events emitted *during* start — notably the initial
          // prompt's own user message — are already in the log by the time we get
          // here, so a live-only subscription would silently drop them.
          await this.#replay(client, session.id, 0);
        } catch (err) {
          const e = err as Error;
          const code: ErrorCode =
            e.name === 'ProjectNotAllowedError'
              ? 'project_not_allowed'
              : e.name === 'SessionLimitError'
                ? 'session_limit'
                : 'internal';
          this.#fail(client, code, e.message);
        }
        return;
      }

      case 'session.resume': {
        try {
          const session = await registry.resume(msg.sessionId);
          client.subscriptions.add(session.id);
          this.#send(client, { t: 'session.updated', session });
        } catch (err) {
          this.#fail(client, 'not_found', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'session.prompt': {
        try {
          registry.require(msg.sessionId).session.prompt(msg.text);
        } catch (err) {
          this.#fail(client, 'not_found', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'session.interrupt': {
        try {
          await registry.require(msg.sessionId).session.interrupt();
        } catch (err) {
          this.#fail(client, 'not_found', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'session.setPermissionMode': {
        if (!VALID_MODES.includes(msg.permissionMode)) {
          this.#fail(client, 'bad_request', `unknown permission mode "${msg.permissionMode}"`);
          return;
        }
        try {
          await registry.require(msg.sessionId).session.setPermissionMode(msg.permissionMode);
          registry.notifyChanged(msg.sessionId);
        } catch (err) {
          this.#fail(client, 'not_found', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'session.setModel': {
        try {
          await registry.require(msg.sessionId).session.setModel(msg.model);
          registry.notifyChanged(msg.sessionId);
        } catch (err) {
          this.#fail(client, 'not_found', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'session.stop':
        await registry.stop(msg.sessionId);
        return;

      case 'session.delete': {
        const removed = await registry.delete(msg.sessionId);
        if (!removed) this.#fail(client, 'not_found', `Unknown session ${msg.sessionId}.`, msg.sessionId);
        return;
      }

      case 'session.rewind': {
        const dryRun = msg.dryRun ?? false;
        try {
          const result = await registry
            .require(msg.sessionId)
            .session.rewindFiles(msg.userMessageId, dryRun);
          this.#send(client, {
            t: 'session.rewound',
            sessionId: msg.sessionId,
            dryRun,
            result: result as RewindResult,
          });
        } catch (err) {
          // Report as a rewind outcome rather than a generic error so the UI can
          // show it in the rewind flow the user is looking at.
          this.#send(client, {
            t: 'session.rewound',
            sessionId: msg.sessionId,
            dryRun,
            result: { canRewind: false, error: (err as Error).message },
          });
        }
        return;
      }

      case 'session.readFile': {
        try {
          const { content, encoding, truncated } = await registry
            .require(msg.sessionId)
            .session.readFile(msg.path);
          this.#send(client, {
            t: 'session.fileContent',
            requestId: msg.requestId,
            content,
            encoding,
            // A refusal is an error; a clipped read is a successful read with a
            // caveat. Conflating them would tell the user they cannot see a file
            // they are in fact looking at.
            ...(content === null
              ? {
                  error:
                    'The daemon could not read that file — it may be missing, or outside what this session is allowed to read.',
                }
              : truncated
                ? { truncated: true }
                : {}),
          });
        } catch (err) {
          this.#send(client, {
            t: 'session.fileContent',
            requestId: msg.requestId,
            content: null,
            encoding: 'utf-8',
            error: (err as Error).message,
          });
        }
        return;
      }

      case 'session.diff': {
        try {
          const entry = registry.require(msg.sessionId);
          // Re-check containment: git runs with this cwd, so the path must still
          // be one the daemon allows even though the session already exists.
          if (!isPathAllowed(entry.session.projectPath, this.deps.config.projectRoots)) {
            this.#fail(client, 'project_not_allowed', 'That project is no longer inside a configured root.');
            return;
          }
          const scope = msg.scope ?? 'session';
          const diff = await gitDiff(entry.session.projectPath, {
            scope,
            ...(scope === 'session' ? { paths: entry.session.touchedFiles } : {}),
          });
          this.#send(client, { t: 'session.diffResult', sessionId: msg.sessionId, diff });
        } catch (err) {
          this.#send(client, {
            t: 'session.diffResult',
            sessionId: msg.sessionId,
            diff: { available: false, reason: (err as Error).message },
          });
        }
        return;
      }

      case 'session.checkpoints': {
        try {
          const checkpoints = await registry.require(msg.sessionId).session.checkpoints();
          this.#send(client, { t: 'session.checkpointList', sessionId: msg.sessionId, checkpoints });
        } catch (err) {
          this.#send(client, {
            t: 'session.checkpointList',
            sessionId: msg.sessionId,
            checkpoints: [],
            error: (err as Error).message,
          });
        }
        return;
      }

      case 'session.models': {
        try {
          const models = await registry.require(msg.sessionId).session.supportedModels();
          this.#send(client, { t: 'session.modelList', sessionId: msg.sessionId, models });
        } catch (err) {
          this.#fail(client, 'bad_request', (err as Error).message, msg.sessionId);
        }
        return;
      }

      case 'subscribe': {
        client.subscriptions.add(msg.sessionId);
        await this.#replay(client, msg.sessionId, msg.sinceSeq);
        return;
      }

      case 'unsubscribe':
        client.subscriptions.delete(msg.sessionId);
        return;

      case 'devices.list':
        this.#send(client, { t: 'devices', devices: auth.listDevices(client.deviceId) });
        return;

      case 'devices.revoke': {
        if (auth.revokeDevice(msg.deviceId)) {
          audit.deviceRevoked(msg.deviceId);
          // Kick any socket still using the revoked device.
          for (const other of this.#clients) {
            if (other.deviceId === msg.deviceId) other.ws.close(4401, 'device revoked');
          }
        }
        this.#send(client, { t: 'devices', devices: auth.listDevices(client.deviceId) });
        return;
      }

      default: {
        const exhaustive: never = msg;
        this.#fail(client, 'bad_request', `unknown message ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  #onHello(client: ClientState, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.#fail(
        client,
        'protocol_version',
        `daemon speaks protocol ${PROTOCOL_VERSION}, client speaks ${msg.protocolVersion}`,
      );
      client.ws.close(4400, 'protocol version mismatch');
      return;
    }

    const verified = this.deps.auth.verify(msg.token);
    if (!verified.ok) {
      this.#fail(client, 'unauthorized', `token rejected: ${verified.reason}`);
      client.ws.close(4401, 'unauthorized');
      return;
    }

    client.authed = true;
    client.deviceId = verified.device.id;
    this.#send(client, {
      t: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      deviceId: verified.device.id,
      sessions: this.deps.registry.list(),
    });
  }

  /**
   * Send everything the client missed. `truncated` is reported honestly rather
   * than papered over — a UI that silently drops history is worse than one that
   * says it has a gap.
   */
  async #replay(client: ClientState, sessionId: string, sinceSeq: number): Promise<void> {
    const entry = this.deps.registry.get(sessionId);
    if (!entry) {
      this.#fail(client, 'not_found', `session ${sessionId} is not running`, sessionId);
      return;
    }
    const { events, truncated } = await entry.log.slice(sinceSeq);
    this.#send(client, {
      t: 'replay.begin',
      sessionId,
      fromSeq: sinceSeq + 1,
      toSeq: entry.log.lastSeq,
    });
    for (const e of events) {
      this.#send(client, { t: 'event', sessionId, seq: e.seq, message: e.message });
    }
    this.#send(client, { t: 'replay.end', sessionId, truncated });
  }

  /* --------------------------------- plumbing -------------------------------- */

  #send(client: ClientState, msg: ServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      this.#clients.delete(client);
    }
  }

  #fail(client: ClientState, code: ErrorCode, message: string, sessionId?: string): void {
    this.#send(client, { t: 'error', code, message, ...(sessionId ? { sessionId } : {}) });
  }

  #broadcast(msg: ServerMessage, filter?: (c: ClientState) => boolean): void {
    for (const client of this.#clients) {
      if (!client.authed) continue;
      if (filter && !filter(client)) continue;
      this.#send(client, msg);
    }
  }
}

/* ---------------------------------- helpers --------------------------------- */

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    // Auth responses must never be cached by an intermediary.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
