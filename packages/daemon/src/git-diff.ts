/**
 * Repo-level diff for a project, via git.
 *
 * This is the practical answer to "what did that unattended session actually do to
 * my code" now that rewind is not available (docs/decisions.md D-012): review the
 * diff from the phone, then keep or `git checkout` it yourself at the desk.
 *
 * Only ever runs git, only ever read-only subcommands, and only ever with the cwd
 * pinned to a path the caller has already checked against `projectRoots`. Arguments
 * are passed as an array — never a shell string — so a path cannot become a
 * command.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generous but bounded: a diff this large is not readable on a phone anyway. */
const MAX_BUFFER = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export interface GitDiffResult {
  available: boolean;
  /** Why a diff could not be produced, for the UI to show verbatim. */
  reason?: string;
  /** Unified patch of tracked, uncommitted changes. */
  patch?: string;
  /** Paths git reports as untracked — they have no diff, but they are new work. */
  untracked?: string[];
  /** True when the patch was clipped because it exceeded the size cap. */
  truncated?: boolean;
  branch?: string;
  /** Which changes this reflects. */
  scope?: 'session' | 'project';
  /** Set when 'session' scope was asked for but there was nothing to scope by. */
  scopeFellBack?: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT_MS,
    windowsHide: true,
    // Keep output stable regardless of the user's git config.
    env: { ...process.env, GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  });
  return stdout;
}

export interface GitDiffOptions {
  /**
   * Limit the diff to these project-relative paths. Passed to git after `--`, so
   * they are unambiguously pathspecs and never options.
   */
  paths?: string[];
  scope?: 'session' | 'project';
}

export async function gitDiff(projectPath: string, options: GitDiffOptions = {}): Promise<GitDiffResult> {
  // Is this a work tree at all? Anything else is a legitimate "no diff here".
  try {
    const inside = (await git(projectPath, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') {
      return { available: false, reason: 'This project is not a git repository.' };
    }
  } catch (err) {
    const message = (err as { code?: string }).code === 'ENOENT'
      ? 'git is not installed on the daemon machine, so no diff is available.'
      : 'This project is not a git repository.';
    return { available: false, reason: message };
  }

  let branch: string | undefined;
  try {
    branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;
  } catch {
    // A repo with no commits yet has no HEAD; not an error worth surfacing.
  }

  // `--` separates pathspecs from options, so a path can never be read as a flag.
  const pathspec = options.paths?.length ? ['--', ...options.paths] : [];
  const scopeFellBack = options.scope === 'session' && pathspec.length === 0;

  let patch = '';
  try {
    // Include staged changes: an agent may have run `git add`.
    patch = await git(projectPath, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M', ...pathspec]);
  } catch {
    try {
      // No HEAD yet (fresh repo) — fall back to the index.
      patch = await git(projectPath, ['diff', '--no-color', '--no-ext-diff', '-M', ...pathspec]);
    } catch (err) {
      return { available: false, reason: `git diff failed: ${(err as Error).message}` };
    }
  }

  let untracked: string[] = [];
  try {
    const out = await git(projectPath, ['ls-files', '--others', '--exclude-standard', ...pathspec]);
    untracked = out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // Non-fatal; the patch is the important part.
  }

  const CAP = 512 * 1024;
  const truncated = patch.length > CAP;

  return {
    available: true,
    patch: truncated ? patch.slice(0, CAP) : patch,
    untracked,
    truncated,
    ...(branch ? { branch } : {}),
    // Report the scope actually used, not the one requested — a session that has
    // written nothing yet gets the project view, and the UI should say so.
    scope: scopeFellBack ? 'project' : (options.scope ?? 'project'),
    ...(scopeFellBack ? { scopeFellBack: true } : {}),
  };
}
