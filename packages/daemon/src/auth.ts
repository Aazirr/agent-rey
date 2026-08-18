/**
 * Authentication for reyd.
 *
 * Threat model: a successful login grants an agent with filesystem and shell
 * access to this machine. Network reachability is already restricted to the
 * tailnet (docs/decisions.md D-003); this module is the second layer, not the
 * only one.
 *
 * Design:
 *  - The password comes from REY_PASSWORD and is hashed with scrypt at boot.
 *    The plaintext is never stored, logged, or written to disk.
 *  - Login returns a device token = `<deviceId>.<HMAC-SHA256(deviceId|expiry)>`.
 *    Tokens are verified by HMAC *and* looked up in a persisted device store, so
 *    a token can be revoked server-side without rotating the signing secret.
 *  - Failed logins are rate limited with exponential backoff and a hard lockout,
 *    because a password guarding shell access will be guessed at if it can be.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import type { DeviceSessionInfo } from '@agent-rey/shared';
import type { Store } from './store.js';

const SCRYPT_KEYLEN = 64;
/** Deliberately costly: this runs once per login attempt, never in a hot path. */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Sliding expiry: re-issue when a token is more than halfway to expiring. */
const RENEW_AFTER_FRACTION = 0.5;

const MIN_PASSWORD_LENGTH = 10;

export interface DeviceRecord {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent?: string;
}

export interface AuthState {
  /** HMAC key for signing device tokens. Persisted so tokens survive restarts. */
  signingSecret: string;
  devices: Record<string, DeviceRecord>;
}

export type LoginFailure =
  | { ok: false; error: 'invalid_password' | 'locked_out' | 'not_configured'; retryAfterMs?: number };

export type LoginSuccess = { ok: true; token: string; deviceId: string; expiresAt: number };

export type VerifyResult =
  | { ok: true; device: DeviceRecord; renewedToken?: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'unknown_device' | 'expired' };

/* -------------------------------------------------------------------------- */

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

/**
 * Login throttle. Keyed by remote address, but the *global* counter is what
 * actually protects us: a tailnet attacker can trivially vary source addresses,
 * so per-IP counting alone would be theatre.
 */
class LoginThrottle {
  #perKey = new Map<string, { failures: number; nextAllowedAt: number }>();
  #globalFailures = 0;
  #globalLockedUntil = 0;

  constructor(
    private readonly maxFailuresBeforeLockout = 10,
    private readonly lockoutMs = 15 * 60 * 1000,
  ) {}

  /** Returns ms to wait, or 0 if the attempt may proceed now. */
  check(key: string, now: number): number {
    if (now < this.#globalLockedUntil) return this.#globalLockedUntil - now;
    const entry = this.#perKey.get(key);
    if (entry && now < entry.nextAllowedAt) return entry.nextAllowedAt - now;
    return 0;
  }

  recordFailure(key: string, now: number): void {
    const entry = this.#perKey.get(key) ?? { failures: 0, nextAllowedAt: 0 };
    entry.failures += 1;
    // 0s, 1s, 2s, 4s, 8s … capped at 30s between attempts.
    const backoff = Math.min(30_000, entry.failures <= 1 ? 0 : 2 ** (entry.failures - 2) * 1000);
    entry.nextAllowedAt = now + backoff;
    this.#perKey.set(key, entry);

    this.#globalFailures += 1;
    if (this.#globalFailures >= this.maxFailuresBeforeLockout) {
      this.#globalLockedUntil = now + this.lockoutMs;
      this.#globalFailures = 0;
    }
  }

  recordSuccess(key: string): void {
    this.#perKey.delete(key);
    this.#globalFailures = 0;
  }

  /** Exposed for the status endpoint and tests. */
  get lockedUntil(): number {
    return this.#globalLockedUntil;
  }
}

/* -------------------------------------------------------------------------- */

export class Auth {
  readonly #salt: Buffer;
  readonly #passwordHash: Buffer | null;
  #signingSecret: Buffer;
  readonly #store: Store<AuthState>;
  readonly #throttle = new LoginThrottle();
  readonly #tokenTtlMs: number;

  constructor(opts: {
    password: string | undefined;
    store: Store<AuthState>;
    tokenTtlMs?: number;
    /** Injectable for tests; defaults to Date.now. */
    now?: () => number;
  }) {
    this.#store = opts.store;
    this.#tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;

    const state = this.#store.data;
    if (!state.signingSecret) {
      state.signingSecret = randomBytes(32).toString('base64url');
      this.#store.save();
    }
    this.#signingSecret = Buffer.from(state.signingSecret, 'base64url');

    // Salt is per-process: the hash is only ever compared in memory against
    // this same process's hash, so it need not be persisted.
    this.#salt = randomBytes(16);
    this.#passwordHash = opts.password ? hashPassword(opts.password, this.#salt) : null;
  }

  get configured(): boolean {
    return this.#passwordHash !== null;
  }

  /**
   * Validate a candidate password from config at boot. Returns a list of
   * problems for the operator; empty means acceptable.
   */
  static validatePassword(password: string | undefined): string[] {
    if (!password) {
      return [
        'REY_PASSWORD is not set. The daemon will refuse all logins until it is.',
      ];
    }
    const problems: string[] = [];
    if (password.length < MIN_PASSWORD_LENGTH) {
      problems.push(`REY_PASSWORD is ${password.length} characters; use at least ${MIN_PASSWORD_LENGTH}.`);
    }
    if (/^(password|changeme|letmein|admin|secret)/i.test(password)) {
      problems.push('REY_PASSWORD starts with a common guessable word.');
    }
    return problems;
  }

  login(opts: {
    password: string;
    label?: string;
    remoteKey: string;
    userAgent?: string;
    now?: number;
  }): LoginSuccess | LoginFailure {
    const now = opts.now ?? Date.now();

    if (!this.#passwordHash) return { ok: false, error: 'not_configured' };

    const waitMs = this.#throttle.check(opts.remoteKey, now);
    if (waitMs > 0) return { ok: false, error: 'locked_out', retryAfterMs: waitMs };

    const candidate = hashPassword(opts.password, this.#salt);
    // Lengths are fixed by SCRYPT_KEYLEN, so timingSafeEqual is safe to call directly.
    if (!timingSafeEqual(candidate, this.#passwordHash)) {
      this.#throttle.recordFailure(opts.remoteKey, now);
      return { ok: false, error: 'invalid_password' };
    }

    this.#throttle.recordSuccess(opts.remoteKey);
    return this.#issue({
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
      now,
    });
  }

  #issue(opts: { label?: string; userAgent?: string; now: number }): LoginSuccess {
    const id = randomBytes(16).toString('base64url');
    const expiresAt = opts.now + this.#tokenTtlMs;
    const record: DeviceRecord = {
      id,
      label: opts.label?.slice(0, 60) || 'Unnamed device',
      createdAt: opts.now,
      lastSeenAt: opts.now,
      expiresAt,
      ...(opts.userAgent ? { userAgent: opts.userAgent.slice(0, 200) } : {}),
    };
    this.#store.data.devices[id] = record;
    this.#store.save();
    return { ok: true, token: this.#sign(id, expiresAt), deviceId: id, expiresAt };
  }

  #sign(deviceId: string, expiresAt: number): string {
    const payload = `${deviceId}.${expiresAt}`;
    const mac = createHmac('sha256', this.#signingSecret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  /**
   * Verify a device token. On success, updates lastSeen and — if the token is
   * past its halfway point — returns a freshly signed replacement so active
   * devices never get logged out mid-use.
   */
  verify(token: string, now = Date.now()): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [deviceId, expiryRaw, mac] = parts as [string, string, string];

    const expiresAt = Number(expiryRaw);
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };

    const expected = createHmac('sha256', this.#signingSecret)
      .update(`${deviceId}.${expiryRaw}`)
      .digest('base64url');
    const macBuf = Buffer.from(mac);
    const expectedBuf = Buffer.from(expected);
    if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
      return { ok: false, reason: 'bad_signature' };
    }

    // Signature is valid, so the id is authentic — but it may have been revoked.
    const device = this.#store.data.devices[deviceId];
    if (!device) return { ok: false, reason: 'unknown_device' };
    if (now >= expiresAt || now >= device.expiresAt) {
      delete this.#store.data.devices[deviceId];
      this.#store.save();
      return { ok: false, reason: 'expired' };
    }

    device.lastSeenAt = now;

    // Renew once the token is past its halfway point, so a device in daily use
    // never hits the expiry wall. Measured on remaining-vs-TTL rather than
    // elapsed-since-creation, which would drift across successive renewals.
    let renewedToken: string | undefined;
    if (expiresAt - now < this.#tokenTtlMs * RENEW_AFTER_FRACTION) {
      device.expiresAt = now + this.#tokenTtlMs;
      renewedToken = this.#sign(deviceId, device.expiresAt);
    }
    this.#store.save();

    return renewedToken ? { ok: true, device, renewedToken } : { ok: true, device };
  }

  listDevices(currentDeviceId?: string): DeviceSessionInfo[] {
    return Object.values(this.#store.data.devices)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        ...(d.userAgent ? { userAgent: d.userAgent } : {}),
        ...(d.id === currentDeviceId ? { current: true as const } : {}),
      }));
  }

  revokeDevice(deviceId: string): boolean {
    if (!this.#store.data.devices[deviceId]) return false;
    delete this.#store.data.devices[deviceId];
    this.#store.save();
    return true;
  }

  /** Nuclear option: rotate the signing secret, invalidating every device at once. */
  revokeAll(): void {
    const secret = randomBytes(32).toString('base64url');
    this.#store.data.signingSecret = secret;
    this.#store.data.devices = {};
    this.#store.save();
    this.#signingSecret = Buffer.from(secret, 'base64url');
  }

  /** Drop expired device records. Called periodically by the server. */
  pruneExpired(now = Date.now()): number {
    let pruned = 0;
    for (const [id, d] of Object.entries(this.#store.data.devices)) {
      if (now >= d.expiresAt) {
        delete this.#store.data.devices[id];
        pruned += 1;
      }
    }
    if (pruned > 0) this.#store.save();
    return pruned;
  }
}
