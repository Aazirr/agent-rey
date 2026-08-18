/**
 * Daemon configuration: environment variables, with a JSON config file for the
 * things that are awkward as env (project roots, per-project tool floors).
 *
 * Precedence: env > config file > default.
 */

import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { PermissionMode } from '@agent-rey/shared';

export interface ProjectPolicy {
  /**
   * Tools this project never allows, regardless of permission mode. A hard
   * floor — see docs/decisions.md D-004.
   */
  disallowedTools?: string[];
}

export interface FileConfig {
  /** Directories scanned for projects. */
  projectRoots?: string[];
  /** How deep to walk each root looking for project markers. */
  scanDepth?: number;
  /** Directory names never descended into during a scan. */
  scanIgnore?: string[];
  /** Keyed by absolute project path. */
  projectPolicies?: Record<string, ProjectPolicy>;
  defaultPermissionMode?: PermissionMode;
  defaultModel?: string;
  /** Origins allowed to open a WebSocket, e.g. a Vercel deployment. */
  allowedOrigins?: string[];
  maxConcurrentSessions?: number;
}

export interface Config {
  host: string;
  port: number;
  password: string | undefined;
  stateDir: string;
  logDir: string;
  projectRoots: string[];
  scanDepth: number;
  scanIgnore: string[];
  projectPolicies: Record<string, ProjectPolicy>;
  defaultPermissionMode: PermissionMode;
  defaultModel: string | undefined;
  allowedOrigins: string[];
  maxConcurrentSessions: number;
  /** Explicit override for the claude executable; normally the SDK's vendored one. */
  claudeExecutable: string | undefined;
  /** Serve the built PWA from the daemon in addition to the API. */
  serveWeb: boolean;
  /** Ring-buffer size per session, in events. */
  eventBufferSize: number;
  /** Enable the SDK's file checkpointing so unattended sessions can be rewound. */
  enableCheckpointing: boolean;
  /** Run agent tool calls inside the SDK sandbox where supported. */
  sandbox: boolean;
  /** Days to keep audit files. 0 disables pruning. */
  auditRetentionDays: number;
  /** Days to keep event logs for sessions no longer in the registry. 0 disables. */
  logRetentionDays: number;
  /**
   * Stop a session after this many minutes with no activity. 0 disables.
   * Stopping is cheap and reversible — a stopped session is resumable with its
   * context intact — so the default reclaims the CLI process rather than holding
   * one per abandoned session indefinitely.
   */
  sessionIdleTimeoutMinutes: number;
}

const DEFAULT_SCAN_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.pnpm-store',
  'AppData',
];

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Expand a leading `~`, make the path absolute, and canonicalise it.
 *
 * The canonicalisation matters more than it looks on Windows. A path in 8.3 short
 * form (`C:\Users\FRANZJ~1\...`) is a different string to the CLI's permission
 * checks, which reject the short form as needing manual approval — so a session
 * rooted at a short path cannot read files in its own project directory.
 * `realpathSync.native` returns the long form. It also resolves symlinks, which
 * is the behaviour we want for a containment boundary: two spellings of the same
 * directory should not be two different answers.
 */
export function expandPath(p: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Path does not exist yet (or is inaccessible) — keep the resolved form; the
    // caller warns about missing roots separately.
    return absolute;
  }
}

export function loadConfig(argv: { configPath?: string } = {}): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const stateDir = expandPath(process.env['REY_STATE_DIR'] ?? join(homedir(), '.agent-rey'));
  const configPath = argv.configPath
    ? expandPath(argv.configPath)
    : expandPath(process.env['REY_CONFIG'] ?? join(stateDir, 'config.json'));

  let file: FileConfig = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig;
    } catch (err) {
      warnings.push(`Ignoring ${configPath}: ${(err as Error).message}`);
    }
  }

  const rootsRaw =
    process.env['REY_PROJECT_ROOTS']?.split(/[;,]/).filter(Boolean) ??
    file.projectRoots ??
    // Default matches where this user keeps work; overridable and it is the
    // only place the daemon will look, so nothing outside it is enumerable.
    [join(homedir(), 'Documents', 'Work', 'Projects')];

  const projectRoots = [...new Set(rootsRaw.map(expandPath))];
  const missing = projectRoots.filter((r) => !existsSync(r));
  for (const r of missing) warnings.push(`Project root does not exist: ${r}`);

  const modeRaw = process.env['REY_DEFAULT_PERMISSION_MODE'] ?? file.defaultPermissionMode;
  let defaultPermissionMode: PermissionMode = 'default';
  if (modeRaw) {
    if (PERMISSION_MODES.includes(modeRaw as PermissionMode)) {
      defaultPermissionMode = modeRaw as PermissionMode;
    } else {
      warnings.push(`Unknown permission mode "${modeRaw}"; falling back to "default".`);
    }
  }

  const policies: Record<string, ProjectPolicy> = {};
  for (const [k, v] of Object.entries(file.projectPolicies ?? {})) {
    policies[expandPath(k)] = v;
  }

  const allowedOrigins = (
    process.env['REY_ALLOWED_ORIGINS']?.split(/[;,]/).filter(Boolean) ??
    file.allowedOrigins ??
    []
  ).map((o) => o.trim().replace(/\/$/, ''));

  const config: Config = {
    // Loopback by default: `tailscale serve` fronts us, so the daemon itself is
    // never exposed on the LAN. Overriding this is a deliberate act.
    host: process.env['REY_HOST'] ?? '127.0.0.1',
    port: envInt('REY_PORT', 8787),
    password: process.env['REY_PASSWORD'],
    stateDir,
    logDir: expandPath(process.env['REY_LOG_DIR'] ?? join(stateDir, 'logs')),
    projectRoots,
    scanDepth: envInt('REY_SCAN_DEPTH', file.scanDepth ?? 3),
    scanIgnore: file.scanIgnore ?? DEFAULT_SCAN_IGNORE,
    projectPolicies: policies,
    defaultPermissionMode,
    defaultModel: process.env['REY_DEFAULT_MODEL'] ?? file.defaultModel,
    allowedOrigins,
    maxConcurrentSessions: envInt('REY_MAX_SESSIONS', file.maxConcurrentSessions ?? 6),
    claudeExecutable: process.env['REY_CLAUDE_EXECUTABLE'],
    serveWeb: envFlag('REY_SERVE_WEB', true),
    eventBufferSize: envInt('REY_EVENT_BUFFER', 2000),
    enableCheckpointing: envFlag('REY_CHECKPOINTING', true),
    sandbox: envFlag('REY_SANDBOX', false),
    // The audit trail outlives transcripts: it is the accountability record for
    // unattended sessions, and it is tiny by comparison.
    auditRetentionDays: envInt('REY_AUDIT_RETENTION_DAYS', 90),
    logRetentionDays: envInt('REY_LOG_RETENTION_DAYS', 30),
    sessionIdleTimeoutMinutes: envInt('REY_SESSION_IDLE_TIMEOUT_MIN', 180),
  };

  return { config, warnings };
}

/**
 * Is `candidate` inside one of the configured roots? Used to reject
 * session.start for arbitrary paths — without this, an authenticated client
 * could run an agent anywhere on the filesystem.
 */
export function isPathAllowed(candidate: string, roots: string[]): boolean {
  // Canonicalise both sides: two spellings of the same directory (8.3 short form,
  // a symlink, a trailing separator) must not produce two different answers for a
  // check that is a security boundary.
  const target = expandPath(candidate);
  return roots.some((root) => {
    const r = expandPath(root);
    return target === r || target.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}${sep()}`);
  });
}

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
