/**
 * Start a session: pick a project, pick a permission mode, optionally seed a prompt.
 *
 * The mode selector starts on "Ask me" every time and never remembers a previous
 * choice. That is the D-004 safeguard made concrete: an unattended mode has to be
 * chosen on purpose, and the consequence is spelled out before you tap Start.
 */

import { useMemo, useState } from 'react';
import type { PermissionMode, ProjectInfo } from '@agent-rey/shared';
import { PERMISSION_MODES } from '../lib/modes.js';

export function NewSessionSheet({
  projects,
  initialProjectPath,
  onClose,
  onStart,
}: {
  projects: ProjectInfo[];
  /** Preselected when the sheet was opened by tapping a specific project. */
  initialProjectPath?: string;
  onClose: () => void;
  onStart: (opts: {
    projectPath: string;
    permissionMode: PermissionMode;
    prompt?: string;
  }) => void;
}): React.JSX.Element {
  const [projectPath, setProjectPath] = useState(initialProjectPath ?? projects[0]?.path ?? '');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [prompt, setPrompt] = useState('');
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects, filter]);

  const selectedMode = PERMISSION_MODES.find((m) => m.value === mode);

  function start(): void {
    if (!projectPath) return;
    onStart({
      projectPath,
      permissionMode: mode,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    });
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="New session">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <header className="sheet__header">
          <h2>New session</h2>
          <button className="iconbutton" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          <label className="field">
            <span className="field__label">Project</span>
            {projects.length > 6 && (
              <input
                className="field__input"
                placeholder="Filter projects…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
              />
            )}
          </label>

          {filtered.length === 0 ? (
            <p className="muted">
              No projects match. Check <code>REY_PROJECT_ROOTS</code> on the daemon.
            </p>
          ) : (
            <ul className="picker">
              {filtered.map((p) => (
                <li key={p.path}>
                  <button
                    className={`picker__item ${p.path === projectPath ? 'picker__item--selected' : ''}`}
                    onClick={() => setProjectPath(p.path)}
                  >
                    <span className="picker__name">{p.name}</span>
                    <span className="picker__meta">{p.branch ?? p.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="field">
            <span className="field__label">Permission mode</span>
            <select
              className="field__input"
              value={mode}
              onChange={(e) => setMode(e.target.value as PermissionMode)}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {selectedMode && (
            <p className={`modeblurb ${selectedMode.unattended ? 'modeblurb--warn' : ''}`}>
              {selectedMode.blurb}
            </p>
          )}

          <label className="field">
            <span className="field__label">First message (optional)</span>
            <textarea
              className="field__input field__input--area"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should it do?"
            />
          </label>
        </div>

        <footer className="sheet__footer">
          <button className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button button--primary" onClick={start} disabled={!projectPath}>
            Start
          </button>
        </footer>
      </div>
    </div>
  );
}
