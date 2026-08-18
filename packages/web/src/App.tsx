/**
 * Top-level screen router.
 *
 * Deliberately a small state machine rather than a router library: there are four
 * states and they are gated on connectivity and auth, not on URLs.
 */

import { useCallback, useEffect, useState } from 'react';
import { resolveDaemonUrl, storedDaemonUrl, type DaemonInfo } from './lib/daemon-url.js';
import { storedToken, clearToken } from './lib/auth.js';
import { Connect } from './screens/Connect.js';
import { Login } from './screens/Login.js';
import { Shell } from './screens/Shell.js';

type Phase =
  | { name: 'resolving' }
  | { name: 'connect'; error?: string }
  | { name: 'login'; daemonUrl: string; info: DaemonInfo }
  | { name: 'ready'; daemonUrl: string; token: string };

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'resolving' });

  const bootstrap = useCallback(async () => {
    setPhase({ name: 'resolving' });
    const resolved = await resolveDaemonUrl();
    if (!resolved) {
      setPhase({
        name: 'connect',
        ...(storedDaemonUrl() ? { error: 'Could not reach the daemon at the saved address.' } : {}),
      });
      return;
    }
    const token = storedToken();
    if (token) {
      setPhase({ name: 'ready', daemonUrl: resolved.url, token: token.token });
      return;
    }
    setPhase({ name: 'login', daemonUrl: resolved.url, info: resolved.info });
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleSignedOut = useCallback(
    (reason?: string) => {
      clearToken();
      void (async () => {
        const resolved = await resolveDaemonUrl();
        if (!resolved) {
          setPhase({ name: 'connect', ...(reason ? { error: reason } : {}) });
          return;
        }
        setPhase({ name: 'login', daemonUrl: resolved.url, info: resolved.info });
      })();
    },
    [],
  );

  switch (phase.name) {
    case 'resolving':
      return (
        <div className="screen screen--center">
          <div className="spinner" aria-label="Connecting" />
          <p className="muted">Looking for the daemon…</p>
        </div>
      );

    case 'connect':
      return <Connect {...(phase.error ? { error: phase.error } : {})} onConnected={() => void bootstrap()} />;

    case 'login':
      return (
        <Login
          daemonUrl={phase.daemonUrl}
          info={phase.info}
          onAuthenticated={(token) => setPhase({ name: 'ready', daemonUrl: phase.daemonUrl, token })}
          onChangeDaemon={() => setPhase({ name: 'connect' })}
        />
      );

    case 'ready':
      return <Shell daemonUrl={phase.daemonUrl} token={phase.token} onSignedOut={handleSignedOut} />;
  }
}
