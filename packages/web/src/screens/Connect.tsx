/**
 * First-run screen: where is your daemon?
 *
 * Only shown when the page is not itself served by the daemon — i.e. the Vercel
 * hosting mode. The address is a runtime setting so one Vercel build works for any
 * tailnet host (docs/decisions.md D-007).
 */

import { useState } from 'react';
import { normalizeDaemonUrl, probe, setDaemonUrl } from '../lib/daemon-url.js';

export function Connect({
  error,
  onConnected,
}: {
  error?: string;
  onConnected: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(error);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const url = normalizeDaemonUrl(value);
    if (!url) return;
    setBusy(true);
    setProblem(undefined);
    const info = await probe(url);
    setBusy(false);
    if (!info) {
      setProblem(
        `No daemon answered at ${url}. Check that reyd is running, that tailscale serve is up, and that you are on the tailnet.`,
      );
      return;
    }
    setDaemonUrl(url);
    onConnected();
  }

  return (
    <div className="screen screen--center">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1 className="card__title">Agent Rey</h1>
        <p className="muted">
          Enter the address of your daemon. This is the machine running your code — usually its
          Tailscale name.
        </p>

        <label className="field">
          <span className="field__label">Daemon address</span>
          <input
            className="field__input"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="laptop.tailnet.ts.net"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>

        {problem && (
          <p className="alert alert--error" role="alert">
            {problem}
          </p>
        )}

        <button className="button button--primary" type="submit" disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Connect'}
        </button>

        <p className="hint">
          https:// is assumed unless you enter localhost. Nothing is sent anywhere except to this
          address.
        </p>
      </form>
    </div>
  );
}
