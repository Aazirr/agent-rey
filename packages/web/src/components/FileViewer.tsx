/**
 * Read a file the agent touched, from the phone.
 *
 * Reads go through the daemon's `session.readFile`, which the CLI gates by the
 * same permissions as the Read tool — so this cannot see anything the session
 * itself could not. A refused or missing file is reported as a reason, never as an
 * empty viewer, because "no content" and "not allowed" are different answers.
 */

import { useEffect, useState } from 'react';
import type { ReyClient } from '../lib/client.js';
import { shortenPath } from '../lib/transcript.js';

export function FileViewer({
  client,
  sessionId,
  path,
  onClose,
}: {
  client: ReyClient;
  sessionId: string;
  path: string;
  onClose: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<{
    loading: boolean;
    content: string | null;
    error?: string;
    truncated?: boolean;
  }>({ loading: true, content: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, content: null });
    void client.readFile(sessionId, path).then((result) => {
      if (cancelled) return;
      setState({
        loading: false,
        content: result.content,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, path]);

  const lines = state.content?.split('\n') ?? [];

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`File ${path}`}>
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel sheet__panel--tall">
        <header className="sheet__header">
          <h2 title={path}>{shortenPath(path, 3)}</h2>
          <button className="iconbutton" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body sheet__body--flush">
          {state.loading && (
            <div className="fileviewer__center">
              <div className="spinner" aria-label="Loading file" />
            </div>
          )}

          {/* An unreadable file is an error. A clipped one is not — it is content
              you are successfully looking at, with a note about the tail. */}
          {!state.loading && state.error && (
            <p className="alert alert--error" role="alert">
              {state.error}
            </p>
          )}

          {!state.loading && state.truncated && (
            <p className="alert alert--info">Showing the first 512 KB — this file is larger.</p>
          )}

          {!state.loading && state.content !== null && (
            <div className="fileviewer" data-testid="file-viewer">
              <pre className="fileviewer__pre">
                {lines.map((line, i) => (
                  <span key={i} className="fileviewer__line">
                    <span className="fileviewer__num">{i + 1}</span>
                    <span className="fileviewer__text">{line || ' '}</span>
                  </span>
                ))}
              </pre>
            </div>
          )}

          {!state.loading && state.content === null && !state.error && (
            <p className="muted">Nothing to show.</p>
          )}
        </div>

        <footer className="sheet__footer">
          <span className="hint">{path}</span>
        </footer>
      </div>
    </div>
  );
}
