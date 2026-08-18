/**
 * Landing page: find a project.
 *
 * Projects are the entry point — sessions live inside a project's own sheet, so
 * listing them here as well was showing the same thing twice. What remains is a
 * search box and the project list, which is what you actually arrive wanting.
 *
 * One exception to "no sessions here": a single line when something is running
 * unattended. Removing the session list would otherwise remove the only place you
 * could notice that an agent is changing files while you are not watching, and
 * that is exactly the thing worth surfacing on arrival.
 */

import { useMemo, useState } from 'react';
import type { ProjectInfo, SessionInfo } from '@agent-rey/shared';
import { isUnattendedMode } from '@agent-rey/shared';
import { relativeTime } from '../lib/format.js';

export function Home({
  sessions,
  projects,
  onOpenProject,
  onNewSession,
  onRefreshProjects,
  onShowDevices,
  onSignOut,
}: {
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  onOpenProject: (projectPath: string) => void;
  onNewSession: () => void;
  onRefreshProjects: () => void;
  onShowDevices: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, { total: number; live: number; lastActivityAt: number }>();
    for (const s of sessions) {
      const entry = map.get(s.projectPath) ?? { total: 0, live: 0, lastActivityAt: 0 };
      entry.total += 1;
      if (s.status !== 'exited') entry.live += 1;
      entry.lastActivityAt = Math.max(entry.lastActivityAt, s.lastActivityAt);
      map.set(s.projectPath, entry);
    }
    return map;
  }, [sessions]);

  const unattended = useMemo(
    () => sessions.filter((s) => s.status !== 'exited' && isUnattendedMode(s.permissionMode)),
    [sessions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : projects;
    // Projects you have worked in recently first — the rest alphabetical.
    return [...matched].sort((a, b) => {
      const aLast = sessionsByProject.get(a.path)?.lastActivityAt ?? 0;
      const bLast = sessionsByProject.get(b.path)?.lastActivityAt ?? 0;
      return bLast - aLast || a.name.localeCompare(b.name);
    });
  }, [projects, query, sessionsByProject]);

  return (
    <div className="screen screen--scroll">
      <header className="topbar">
        <h1 className="topbar__title">Agent Rey</h1>
        <div className="topbar__actions">
          <button className="iconbutton" onClick={onShowDevices} title="Devices" aria-label="Devices">
            ⚙
          </button>
          <button className="iconbutton" onClick={onSignOut} title="Sign out" aria-label="Sign out">
            ⏻
          </button>
        </div>
      </header>

      {/* First thing under the header: starting work is the most common reason to
          open the app, so it should not be a scroll away past 23 projects. */}
      <button className="button button--primary button--wide" onClick={() => onNewSession()}>
        New session
      </button>

      {unattended.length > 0 && (
        <p className="alert alert--warn" data-testid="unattended-banner">
          {unattended.length} session{unattended.length === 1 ? '' : 's'} running unattended in{' '}
          {[...new Set(unattended.map((s) => s.projectName))].join(', ')}.
        </p>
      )}

      <input
        className="field__input"
        type="search"
        inputMode="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Search projects…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search projects"
        data-testid="project-search"
      />

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">
            {query ? `${filtered.length} of ${projects.length}` : `${projects.length} projects`}
          </h2>
          <button className="linkbutton" onClick={onRefreshProjects}>
            Rescan
          </button>
        </div>

        {projects.length === 0 ? (
          <p className="muted">
            No projects found. Check <code>REY_PROJECT_ROOTS</code> on the daemon.
          </p>
        ) : filtered.length === 0 ? (
          <p className="muted">Nothing matches “{query}”.</p>
        ) : (
          <ul className="list list--compact" data-testid="project-list">
            {filtered.map((p) => {
              const counts = sessionsByProject.get(p.path);
              return (
                <li key={p.path} className="row">
                  <button className="row__button" onClick={() => onOpenProject(p.path)}>
                    <div className="row__main">
                      <span className="row__title">{p.name}</span>
                      <span className="row__sub">
                        {[
                          p.branch,
                          counts
                            ? `${counts.total} session${counts.total === 1 ? '' : 's'}` +
                              (counts.live > 0 ? `, ${counts.live} live` : '')
                            : null,
                          counts ? relativeTime(counts.lastActivityAt) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || p.path}
                      </span>
                    </div>
                    {counts && counts.live > 0 && <span className="dot" aria-label="has a live session" />}
                    <span className="row__chevron" aria-hidden>
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
