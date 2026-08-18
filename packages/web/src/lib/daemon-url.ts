/**
 * Where is the daemon?
 *
 * Two hosting modes have to work from the same bundle (docs/decisions.md D-007):
 *  - served BY the daemon → same origin, nothing to configure
 *  - served from Vercel   → the daemon is on the user's tailnet, so its URL is a
 *                           runtime setting, never baked into the build
 *
 * The URL is therefore resolved at runtime and remembered in localStorage. A
 * Vercel build must not hardcode a tailnet hostname.
 */

const STORAGE_KEY = 'rey.daemonUrl';

export interface DaemonInfo {
  daemonVersion: string;
  protocolVersion: number;
  authConfigured: boolean;
}

export function storedDaemonUrl(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDaemonUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, normalizeDaemonUrl(url));
}

export function clearDaemonUrl(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Accepts `laptop.tailnet.ts.net`, `https://host:8787`, or a bare host:port. */
export function normalizeDaemonUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, '');
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) {
    // Assume TLS unless it is obviously a loopback dev address.
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(value);
    value = `${isLocal ? 'http' : 'https'}://${value}`;
  }
  return value;
}

export function wsUrlFor(httpUrl: string): string {
  return `${httpUrl.replace(/^http/i, 'ws')}/ws`;
}

/**
 * Resolve the daemon URL: an explicit stored value wins, otherwise try the page's
 * own origin, which succeeds when the daemon is serving this bundle.
 */
export async function resolveDaemonUrl(): Promise<{ url: string; info: DaemonInfo } | null> {
  const stored = storedDaemonUrl();
  const candidates = stored ? [stored] : [];
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    candidates.push(location.origin.replace(/\/+$/, ''));
  }

  for (const candidate of candidates) {
    const info = await probe(candidate);
    if (info) {
      if (candidate !== stored) setDaemonUrl(candidate);
      return { url: candidate, info };
    }
  }
  return null;
}

export async function probe(url: string, timeoutMs = 6000): Promise<DaemonInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/info`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const info = (await res.json()) as DaemonInfo;
    return typeof info.protocolVersion === 'number' ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
