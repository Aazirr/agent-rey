/**
 * Connection state, shown only when it is not fine.
 *
 * A phone-driven agent disconnects routinely, so the banner has to distinguish
 * "briefly reconnecting, your turn is still running on the daemon" from "actually
 * broken". Hiding it entirely would make a stalled UI look like a finished turn.
 */

import type { ConnectionState } from '../lib/client.js';

export function ConnectionBanner({
  state,
  detail,
}: {
  state: ConnectionState;
  detail?: string;
}): React.JSX.Element | null {
  if (state === 'open' || state === 'idle') return null;

  const text =
    state === 'connecting'
      ? 'Connecting…'
      : state === 'reconnecting'
        ? 'Reconnecting — your session keeps running on the daemon'
        : state === 'unauthorized'
          ? 'Session expired'
          : 'Connection failed';

  return (
    <div className={`banner banner--${state}`} role="status">
      <span>{text}</span>
      {detail && state !== 'connecting' && <span className="banner__detail">{detail}</span>}
    </div>
  );
}
