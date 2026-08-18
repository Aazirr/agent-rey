/**
 * Normalising a tool call's target path into a git pathspec.
 *
 * Split out from `agent-session.ts` so it can be tested without importing the
 * Agent SDK. The logic is small but every branch is a way to get the scoped diff
 * wrong: an absolute path, a relative one, a path outside the project, or a
 * Windows separator that git will not match.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/** Tools that mutate a file. A `Read` says nothing about what changed. */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * The project-relative, forward-slashed path a mutating tool call targeted, or
 * null when there is nothing usable.
 *
 * Returns null for paths outside the project: git pathspecs are resolved against
 * the repo, so handing it an outside path would either match nothing or — worse —
 * widen the diff unexpectedly.
 */
export function toProjectRelative(projectPath: string, rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;

  const absolute = isAbsolute(rawPath) ? rawPath : resolve(projectPath, rawPath);
  const rel = relative(projectPath, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  // git wants forward slashes even on Windows.
  return rel.split('\\').join('/');
}

/** The path a mutating tool call targeted, from its tool input. */
export function touchedPathFromToolInput(projectPath: string, toolInput: unknown): string | null {
  const obj = (toolInput ?? {}) as Record<string, unknown>;
  const raw = obj['file_path'] ?? obj['notebook_path'] ?? obj['path'];
  return toProjectRelative(projectPath, raw);
}
