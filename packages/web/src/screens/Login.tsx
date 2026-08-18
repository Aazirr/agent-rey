/**
 * Password gate.
 *
 * A successful login yields an agent with shell access to the daemon's machine, so
 * this screen is honest about that rather than treating it as a routine sign-in.
 */

import { useState } from 'react';
import { login } from '../lib/auth.js';
import type { DaemonInfo } from '../lib/daemon-url.js';

export function Login({
  daemonUrl,
  info,
  onAuthenticated,
  onChangeDaemon,
}: {
  daemonUrl: string;
  info: DaemonInfo;
  onAuthenticated: (token: string) => void;
  onChangeDaemon: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setProblem(null);
    const result = await login(daemonUrl, password);
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onAuthenticated(result.token);
      return;
    }
    setProblem(result.message);
    setPassword('');
  }

  const host = safeHost(daemonUrl);

  return (
    <div className="screen screen--center">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1 className="card__title">Agent Rey</h1>
        <p className="muted">
          Unlock <strong>{host}</strong>
        </p>

        {!info.authConfigured && (
          <p className="alert alert--error">
            This daemon has no <code>REY_PASSWORD</code> set, so every login is refused. Set it in the
            daemon's environment and restart reyd.
          </p>
        )}

        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!info.authConfigured}
            autoFocus
          />
        </label>

        {problem && (
          <p className="alert alert--error" role="alert">
            {problem}
          </p>
        )}

        <button
          className="button button--primary"
          type="submit"
          disabled={busy || !password || !info.authConfigured}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>

        <p className="hint">
          This grants an agent that can read and change files and run commands on that machine. Stay
          on your tailnet.
        </p>

        <button className="button button--ghost" type="button" onClick={onChangeDaemon}>
          Use a different daemon
        </button>
      </form>
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
