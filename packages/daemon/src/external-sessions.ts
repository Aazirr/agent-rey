/**
 * Sessions the CLI knows about that Agent Rey did not start — the ones from the
 * Claude Code VSCode extension or a terminal.
 *
 * They are read from the CLI's own session store, which is shared: anything using
 * the same `claude` credentials writes there. That is why a session you started at
 * the desk can be surfaced on your phone at all.
 *
 * Two things learned the hard way (docs/decisions.md D-014):
 *  - do NOT filter with `listSessions({ dir })`. The CLI records the project path
 *    with whatever casing its process was launched with, and the filter matches
 *    exactly, so `C:\Users\...` silently misses sessions stored as `c:\Users\...`.
 *    Filter here instead, case-insensitively.
 *  - an empty result from that filter is indistinguishable from "no sessions",
 *    which is how a working feature got withdrawn once.
 */

import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { ExternalSession } from '@agent-rey/shared';

/** Windows path comparison must ignore case and separator direction. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export async function listExternalSessions(opts: {
  projectPath: string;
  /** Agent session ids already owned by Agent Rey; these are not "external". */
  knownAgentSessionIds: ReadonlySet<string>;
  limit?: number;
}): Promise<ExternalSession[]> {
  const all = await listSessions({ limit: opts.limit ?? 200 });

  return all
    .filter((s) => {
      const cwd = (s as { cwd?: string }).cwd;
      return typeof cwd === 'string' && samePath(cwd, opts.projectPath);
    })
    .filter((s) => !opts.knownAgentSessionIds.has(String((s as { sessionId?: string }).sessionId ?? '')))
    .map((s) => {
      const raw = s as {
        sessionId?: string;
        summary?: string;
        firstPrompt?: string;
        customTitle?: string;
        lastModified?: number | string;
        gitBranch?: string;
        cwd?: string;
      };
      const modified = raw.lastModified;
      const out: ExternalSession = {
        sessionId: String(raw.sessionId ?? ''),
        lastModified: typeof modified === 'number' ? modified : Date.parse(String(modified ?? '')) || 0,
        cwd: raw.cwd ?? opts.projectPath,
      };
      const summary = raw.customTitle || raw.summary || raw.firstPrompt;
      if (summary) out.summary = String(summary).slice(0, 200);
      if (raw.gitBranch) out.gitBranch = raw.gitBranch;
      return out;
    })
    .filter((s) => s.sessionId.length > 0)
    .sort((a, b) => b.lastModified - a.lastModified);
}
