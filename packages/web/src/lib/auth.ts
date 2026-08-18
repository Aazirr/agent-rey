/**
 * Login against the daemon and remember the device token.
 *
 * The password is sent to the daemon and nowhere else — never to the origin
 * serving this bundle when that origin is Vercel (docs/decisions.md D-007).
 * It is never written to storage; only the resulting token is.
 */

const TOKEN_KEY = 'rey.token';
const EXPIRY_KEY = 'rey.tokenExpiresAt';

export interface StoredToken {
  token: string;
  expiresAt: number;
}

export function storedToken(): StoredToken | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiresAt = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    if (!token) return null;
    // Treat a token expiring within a minute as already gone.
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - Date.now() < 60_000) {
      clearToken();
      return null;
    }
    return { token, expiresAt };
  } catch {
    return null;
  }
}

export function saveToken(t: StoredToken): void {
  localStorage.setItem(TOKEN_KEY, t.token);
  localStorage.setItem(EXPIRY_KEY, String(t.expiresAt));
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

export type LoginOutcome =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; message: string; retryAfterMs?: number };

/** A label so the device list is readable later; derived, never asked for. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const model = /;\s*([^;)]+)\s+Build\//.exec(ua)?.[1];
    return model?.trim() || 'Android phone';
  }
  if (/Windows/.test(ua)) return 'Windows desktop';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux desktop';
  return 'Browser';
}

export async function login(daemonUrl: string, password: string): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch(`${daemonUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, label: deviceLabel() }),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      message: 'Could not reach the daemon. Is it running, and are you on the tailnet?',
    };
  }

  let body: {
    ok?: boolean;
    token?: string;
    expiresAt?: number;
    error?: string;
    retryAfterMs?: number;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, message: `Unexpected response from the daemon (${res.status}).` };
  }

  if (res.ok && body.ok && body.token && body.expiresAt) {
    saveToken({ token: body.token, expiresAt: body.expiresAt });
    return { ok: true, token: body.token, expiresAt: body.expiresAt };
  }

  switch (body.error) {
    case 'invalid_password':
      return { ok: false, message: 'Wrong password.' };
    case 'locked_out': {
      const seconds = Math.ceil((body.retryAfterMs ?? 0) / 1000);
      const outcome: LoginOutcome = {
        ok: false,
        message: seconds > 0 ? `Too many attempts. Try again in ${formatWait(seconds)}.` : 'Too many attempts.',
      };
      if (body.retryAfterMs) outcome.retryAfterMs = body.retryAfterMs;
      return outcome;
    }
    case 'not_configured':
      return {
        ok: false,
        message: 'The daemon has no REY_PASSWORD set, so it refuses every login. Set it and restart reyd.',
      };
    default:
      return { ok: false, message: `Login failed (${res.status}).` };
  }
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
