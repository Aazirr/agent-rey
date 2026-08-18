/**
 * Everything uncommitted in the session's project, per file.
 *
 * This is what you open after an unattended session has been working while you were
 * away. Since rewind is unavailable (docs/decisions.md D-012), reviewing here and
 * then reverting with git at the desk is the actual workflow — so the sheet is
 * explicit that it only shows changes and cannot undo them.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ProjectDiff } from '@agent-rey/shared';
import type { ReyClient } from '../lib/client.js';
import { parseUnifiedPatch } from '../lib/diff.js';
import { DiffView } from './DiffView.js';
import { shortenPath } from '../lib/transcript.js';

export function ProjectDiffSheet({
  client,
  sessionId,
  onClose,
}: {
  client: ReyClient;
  sessionId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Defaults to this session's own changes: after an unattended run, "what did it
  // do" is the question, and the whole working tree may include your own work.
  const [scope, setScope] = useState<'session' | 'project'>('session');

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setOpenPath(null);
    void client.fetchDiff(sessionId, scope).then((result) => {
      if (!cancelled) setDiff(result);
    });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, scope]);

  const files = useMemo(() => (diff?.patch ? parseUnifiedPatch(diff.patch) : []), [diff]);
  const open = files.find((f) => f.path === openPath) ?? null;

  const totals = files.reduce(
    (acc, f) => ({ additions: acc.additions + f.stat.additions, deletions: acc.deletions + f.stat.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Project changes">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel sheet__panel--tall">
        <header className="sheet__header">
          {open ? (
            <>
              <button className="iconbutton" onClick={() => setOpenPath(null)} aria-label="Back to file list">
                ‹
              </button>
              <h2 title={open.path}>{shortenPath(open.path, 3)}</h2>
            </>
          ) : (
            <h2>Changes{diff?.branch ? ` · ${diff.branch}` : ''}</h2>
          )}
          <button className="iconbutton" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body" data-testid="project-diff">
          {!open && (
            <div className="scopebar" role="group" aria-label="Diff scope">
              <button
                className={`scopebar__btn ${scope === 'session' ? 'scopebar__btn--active' : ''}`}
                onClick={() => setScope('session')}
              >
                This session
              </button>
              <button
                className={`scopebar__btn ${scope === 'project' ? 'scopebar__btn--active' : ''}`}
                onClick={() => setScope('project')}
              >
                Whole project
              </button>
            </div>
          )}

          {diff?.scopeFellBack && !open && (
            <p className="alert alert--info">
              This session has not written any files yet, so this is the whole project.
            </p>
          )}

          {!diff && (
            <div className="rewind__center">
              <div className="spinner" aria-label="Loading changes" />
              <span className="muted">Reading changes…</span>
            </div>
          )}

          {diff && !diff.available && <p className="alert alert--info">{diff.reason}</p>}

          {diff?.available && open && <DiffView lines={open.lines} stat={open.stat} />}

          {diff?.available && !open && (
            <>
              {files.length === 0 && (diff.untracked?.length ?? 0) === 0 && (
                <p className="alert alert--info">
                  {scope === 'session' && !diff.scopeFellBack
                    ? 'This session has not changed anything that git can see.'
                    : 'Nothing uncommitted. The working tree is clean.'}
                </p>
              )}

              {files.length > 0 && (
                <>
                  <p className="muted">
                    {files.length} changed file{files.length === 1 ? '' : 's'} ·{' '}
                    <span className="diff__stat-add">+{totals.additions}</span>{' '}
                    <span className="diff__stat-del">−{totals.deletions}</span>
                  </p>
                  <ul className="picker">
                    {files.map((f) => (
                      <li key={f.path}>
                        <button className="picker__item" onClick={() => setOpenPath(f.path)}>
                          <span className="picker__name">{shortenPath(f.path, 2)}</span>
                          <span className="picker__meta">
                            <span className="diff__stat-add">+{f.stat.additions}</span>{' '}
                            <span className="diff__stat-del">−{f.stat.deletions}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {(diff.untracked?.length ?? 0) > 0 && (
                <>
                  <p className="section__title">New, untracked</p>
                  <ul className="rewind__files">
                    {diff.untracked!.slice(0, 100).map((p) => (
                      <li key={p} title={p}>
                        {shortenPath(p, 3)}
                      </li>
                    ))}
                    {diff.untracked!.length > 100 && (
                      <li className="muted">…and {diff.untracked!.length - 100} more</li>
                    )}
                  </ul>
                </>
              )}

              {diff.truncated && (
                <p className="alert alert--info">
                  The diff was clipped because it is very large; later files may be missing.
                </p>
              )}

              <p className="hint">
                This is a read-only view. To undo any of it, use git at the desk — Agent Rey cannot
                revert changes for you.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
