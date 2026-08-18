/**
 * Which devices can reach this daemon, and a way to cut one off.
 *
 * This is the practical half of D-008: a lost phone should be revocable from
 * another phone without rotating the signing secret and logging everything out.
 */

import type { DeviceSessionInfo } from '@agent-rey/shared';
import { relativeTime } from '../lib/format.js';

export function DevicesSheet({
  devices,
  onRevoke,
  onClose,
}: {
  devices: DeviceSessionInfo[];
  onRevoke: (deviceId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Devices">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <header className="sheet__header">
          <h2>Devices</h2>
          <button className="iconbutton" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          {devices.length === 0 ? (
            <p className="muted">No devices signed in.</p>
          ) : (
            <ul className="list list--compact">
              {devices.map((d) => (
                <li key={d.id} className="row row--static">
                  <div className="row__main">
                    <span className="row__title">
                      {d.label}
                      {d.current && <span className="tag">this device</span>}
                    </span>
                    <span className="row__sub">last seen {relativeTime(d.lastSeenAt)}</span>
                  </div>
                  {!d.current && (
                    <button className="linkbutton linkbutton--danger" onClick={() => onRevoke(d.id)}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">
            Revoking a device signs it out immediately. Anything it had running on the daemon keeps
            running — stop the session itself if that is what you want.
          </p>
        </div>
      </div>
    </div>
  );
}
