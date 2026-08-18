/**
 * Sessions in one project: resume an existing one, or start a new one.
 *
 * Tapping a project used to jump straight to "new session", which quietly
 * encouraged piling up sessions in the same folder. Coming back to what you were
 * already doing is the common case, so it goes first and starting fresh is the
 * deliberate act.
 *
 * Long-press enters selection mode for deleting. On a phone that beats a row of
 * small icons: nothing is on screen until you want it, and the targets are the
 * full rows you were already touching.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ExternalSession, ProjectInfo, SessionInfo } from '@agent-rey/shared';
import { isUnattendedMode } from '@agent-rey/shared';
import { StatusPill } from './StatusPill.js';
import { relativeTime, truncate } from '../lib/format.js';
import { useLongPress } from '../hooks/useLongPress.js';
import type { ReyClient } from '../lib/client.js';

export function ProjectSessionsSheet({
  project,
  sessions,
  client,
  onOpenSession,
  onNewSession,
  onContinueExternal,
  onDeleteSessions,
  onClose,
}: {
  project: ProjectInfo;
  sessions: SessionInfo[];
  client: ReyClient;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onContinueExternal: (externalId: string) => void;
  onDeleteSessions: (ids: string[]) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const selecting = selected.size > 0;
  const [external, setExternal] = useState<ExternalSession[] | null>(null);

  // Sessions started at the desk (VSCode, terminal) live in the CLI's own store,
  // which is shared — so they can be listed here even though Agent Rey never
  // started them.
  useEffect(() => {
    let cancelled = false;
    setExternal(null);
    void client.listExternalSessions(project.path).then(({ sessions: found }) => {
      if (!cancelled) setExternal(found);
    });
    return () => {
      cancelled = true;
    };
  }, [client, project.path]);

  const mine = useMemo(
    () =>
      sessions
        .filter((s) => s.projectPath === project.path)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [sessions, project.path],
  );

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmDelete(): void {
    onDeleteSessions([...selected]);
    setSelected(new Set());
    setConfirming(false);
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`Sessions in ${project.name}`}>
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <header className="sheet__header">
          {selecting ? (
            <>
              <button className="iconbutton" onClick={() => setSelected(new Set())} aria-label="Cancel selection">
                ✕
              </button>
              <h2>{selected.size} selected</h2>
              <button
                className="linkbutton linkbutton--danger"
                onClick={() => setConfirming(true)}
                data-testid="delete-selected"
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <div className="sheet__heading">
                <h2>{project.name}</h2>
                {project.branch && <span className="sheet__sub">{project.branch}</span>}
              </div>
              <button className="iconbutton" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </>
          )}
        </header>

        <div className="sheet__body" data-testid="project-sessions">
          {confirming && (
            <div className="alert alert--error confirm">
              <span>
                Delete {selected.size} session{selected.size === 1 ? '' : 's'}? Running ones are stopped
                first. Your files are not touched.
              </span>
              <div className="confirm__actions">
                <button className="button button--ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button className="button button--danger" onClick={confirmDelete} data-testid="confirm-delete">
                  Delete
                </button>
              </div>
            </div>
          )}

          {mine.length === 0 && !selecting && (
            <p className="muted">No sessions in this project yet.</p>
          )}

          {mine.length === 0 ? null : (
            <>
              <p className="hint">
                {selecting ? 'Tap to select more.' : 'Tap to resume · press and hold to select'}
              </p>
              <ul className="list list--compact">
                {mine.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    selecting={selecting}
                    selected={selected.has(s.id)}
                    onOpen={() => onOpenSession(s.id)}
                    onToggle={() => toggle(s.id)}
                  />
                ))}
              </ul>
            </>
          )}

          {/* Sessions from VSCode or a terminal. Continuing one FORKS it, so the
              copy still open at the desk is never disturbed. */}
          {external && external.length > 0 && !selecting && (
            <>
              <p className="section__title">Started elsewhere</p>
              <p className="hint">
                From VSCode or a terminal. Continuing one makes a copy here — the original is left
                alone, so whatever is open at your desk keeps working.
              </p>
              <ul className="list list--compact" data-testid="external-sessions">
                {external.slice(0, 15).map((s) => (
                  <li key={s.sessionId} className="row">
                    <button className="row__button" onClick={() => onContinueExternal(s.sessionId)}>
                      <div className="row__main">
                        <span className="row__title">
                          {s.summary ? truncate(s.summary, 60) : s.sessionId.slice(0, 8)}
                        </span>
                        <span className="row__sub">
                          {[s.gitBranch, relativeTime(s.lastModified)].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <span className="tag">continue</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="sheet__footer">
          <button className="button button--primary button--wide" onClick={onNewSession} disabled={selecting}>
            New session here
          </button>
        </footer>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  selecting,
  selected,
  onOpen,
  onToggle,
}: {
  session: SessionInfo;
  selecting: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
}): React.JSX.Element {
  // Once selection mode is on, a plain tap toggles rather than opens — otherwise
  // adding a second row to the selection would navigate away instead.
  const handlers = useLongPress(onToggle, selecting ? onToggle : onOpen);

  return (
    <li className={`row ${selected ? 'row--selected' : ''}`}>
      <button
        className="row__button"
        {...handlers}
        aria-pressed={selecting ? selected : undefined}
        data-testid="session-row"
      >
        {selecting && (
          <span className={`checkbox ${selected ? 'checkbox--on' : ''}`} aria-hidden>
            {selected ? '✓' : ''}
          </span>
        )}
        <div className="row__main">
          <span className="row__title">
            {session.title ?? session.projectName}
            {isUnattendedMode(session.permissionMode) && session.status !== 'exited' && (
              <span className="tag tag--warn">unattended</span>
            )}
          </span>
          <span className="row__sub">
            {relativeTime(session.lastActivityAt)}
            {session.costUsd ? ` · $${session.costUsd.toFixed(3)}` : ''}
          </span>
        </div>
        <StatusPill status={session.status} />
      </button>
    </li>
  );
}
