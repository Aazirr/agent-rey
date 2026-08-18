/**
 * Undo an unattended session's file changes.
 *
 * This is the real payoff of D-004: a session may act without asking, so there has
 * to be an actual undo rather than only an audit log to read afterwards. It was
 * withdrawn once on a misdiagnosis (D-012) and restored when the anchor lookup
 * turned out to be a bad `dir` filter, not missing data (D-014).
 *
 * Always previews before applying. A rewind rewrites files in a real working tree,
 * so the flow is choose → dry run → confirm. The preview's own limitation is
 * stated rather than hidden: `skippedLinks` is only populated by a real rewind, so
 * a preview can understate what will be left alone.
 */

import { useEffect, useState } from 'react';
import type { Checkpoint, RewindResult } from '@agent-rey/shared';
import type { ReyClient } from '../lib/client.js';
import { shortenPath } from '../lib/transcript.js';
import { truncate } from '../lib/format.js';

type Phase =
  | { name: 'loading' }
  | { name: 'choose'; checkpoints: Checkpoint[]; error?: string }
  | { name: 'previewing'; target: Checkpoint }
  | { name: 'preview'; target: Checkpoint; result: RewindResult }
  | { name: 'applying'; target: Checkpoint }
  | { name: 'done'; result: RewindResult };

export function RewindSheet({
  client,
  sessionId,
  checkpointing,
  onClose,
}: {
  client: ReyClient;
  sessionId: string;
  checkpointing: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void client.listCheckpoints(sessionId).then(({ checkpoints, error }) => {
      if (cancelled) return;
      setPhase({ name: 'choose', checkpoints, ...(error !== undefined ? { error } : {}) });
    });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId]);

  async function preview(target: Checkpoint): Promise<void> {
    setPhase({ name: 'previewing', target });
    const result = await client.rewind(sessionId, target.uuid, true);
    setPhase({ name: 'preview', target, result });
  }

  async function apply(target: Checkpoint): Promise<void> {
    setPhase({ name: 'applying', target });
    const result = await client.rewind(sessionId, target.uuid, false);
    setPhase({ name: 'done', result });
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Rewind files">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <header className="sheet__header">
          <h2>Rewind files</h2>
          <button className="iconbutton" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body" data-testid="rewind-sheet">
          {!checkpointing && (
            <p className="alert alert--error">
              File checkpointing is off for this session, so there is nothing to rewind to. Enable{' '}
              <code>REY_CHECKPOINTING</code> on the daemon and start a new session.
            </p>
          )}

          {phase.name === 'loading' && (
            <div className="rewind__center">
              <div className="spinner" aria-label="Loading checkpoints" />
              <span className="muted">Finding points to rewind to…</span>
            </div>
          )}

          {phase.name === 'choose' && (
            <>
              <p className="muted">Restore files to their state just before one of your messages.</p>
              {phase.error && <p className="alert alert--error">{phase.error}</p>}
              {phase.checkpoints.length === 0 ? (
                <p className="alert alert--info">
                  No rewind points yet. They appear once this session has taken a turn.
                </p>
              ) : (
                <ul className="picker">
                  {/* Newest first: what you want to undo is usually the last thing. */}
                  {[...phase.checkpoints].reverse().map((c) => (
                    <li key={c.uuid}>
                      <button className="picker__item" onClick={() => void preview(c)}>
                        <span className="picker__name">#{c.index}</span>
                        <span className="picker__meta">{truncate(c.preview, 90)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {(phase.name === 'previewing' || phase.name === 'applying') && (
            <>
              <blockquote className="rewind__quote">{truncate(phase.target.preview, 160)}</blockquote>
              <div className="rewind__center">
                <div className="spinner" aria-label={phase.name === 'applying' ? 'Rewinding' : 'Checking'} />
                <span className="muted">
                  {phase.name === 'applying' ? 'Rewinding…' : 'Checking what would change…'}
                </span>
              </div>
            </>
          )}

          {phase.name === 'preview' && (
            <>
              <blockquote className="rewind__quote">{truncate(phase.target.preview, 160)}</blockquote>
              <Outcome result={phase.result} preview />
            </>
          )}

          {phase.name === 'done' && <Outcome result={phase.result} preview={false} />}
        </div>

        <footer className="sheet__footer">
          {phase.name === 'done' ? (
            <button className="button button--primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="button button--ghost" onClick={onClose}>
                Cancel
              </button>
              {phase.name === 'preview' && (
                <button
                  className="button button--danger"
                  onClick={() => void apply(phase.target)}
                  disabled={!phase.result.canRewind || !checkpointing}
                  data-testid="apply-rewind"
                >
                  Rewind files
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Outcome({ result, preview }: { result: RewindResult; preview: boolean }): React.JSX.Element {
  if (result.error) {
    return (
      <p className="alert alert--error" role="alert">
        {result.error}
      </p>
    );
  }

  if (!result.canRewind) {
    return (
      <p className="alert alert--info">
        Nothing to rewind to at this point. Checkpoints only exist for files the session actually
        changed after this message.
      </p>
    );
  }

  const files = result.filesChanged ?? [];

  return (
    <>
      <p className="alert alert--info">
        {preview
          ? `${files.length} file${files.length === 1 ? '' : 's'} would be restored.`
          : `Restored ${files.length} file${files.length === 1 ? '' : 's'}.`}
        {(result.insertions !== undefined || result.deletions !== undefined) &&
          ` +${result.insertions ?? 0} −${result.deletions ?? 0}`}
      </p>

      {files.length > 0 && (
        <ul className="rewind__files">
          {files.slice(0, 50).map((f) => (
            <li key={f} title={f}>
              {shortenPath(f, 3)}
            </li>
          ))}
          {files.length > 50 && <li className="muted">…and {files.length - 50} more</li>}
        </ul>
      )}

      {preview && (
        <p className="hint">
          This preview does not account for files skipped for link safety — a symlink or moved
          parent directory at a tracked path is left alone, and that is only reported after a real
          rewind.
        </p>
      )}

      {!preview && result.skippedLinks !== undefined && result.skippedLinks > 0 && (
        <p className="alert alert--error">
          {result.skippedLinks} file{result.skippedLinks === 1 ? ' was' : 's were'} left unchanged for
          link safety — a symlink, hard link, or moved parent directory was found at the tracked
          path. Check those by hand.
        </p>
      )}

      {!preview && (
        <p className="hint">
          Only files are restored. The conversation is unchanged, and anything outside the checkpoint
          — new commits, installs, side effects of commands — is untouched.
        </p>
      )}
    </>
  );
}
