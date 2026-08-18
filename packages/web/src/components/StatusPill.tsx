import type { SessionStatus } from '@agent-rey/shared';

const LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  thinking: 'working',
  interrupting: 'stopping',
  exited: 'stopped',
  error: 'error',
};

export function StatusPill({ status }: { status: SessionStatus }): React.JSX.Element {
  return <span className={`pill pill--${status}`}>{LABEL[status]}</span>;
}
