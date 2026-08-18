/**
 * Binds a ReyClient to React state.
 *
 * Two details that matter more than they look:
 *  - transcripts are keyed by session id and reduced per event, so a replayed gap
 *    after reconnect is applied by the same code path as a live event
 *  - `visibilitychange` and `online` short-circuit the reconnect backoff, because
 *    a user who just unlocked their phone should not wait out an exponential delay
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo, ProjectInfo, DeviceSessionInfo } from '@agent-rey/shared';
import { ReyClient, type ConnectionState } from '../lib/client.js';
import { emptyTranscript, reduceEvent, type TranscriptState } from '../lib/transcript.js';

export interface ReyState {
  client: ReyClient;
  connection: ConnectionState;
  connectionDetail?: string;
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  devices: DeviceSessionInfo[];
  transcripts: Map<string, TranscriptState>;
  lastError: { code: string; message: string } | null;
  clearError: () => void;
}

export function useReyClient(daemonUrl: string, token: string): ReyState {
  const client = useMemo(() => new ReyClient(daemonUrl, token), [daemonUrl, token]);

  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [devices, setDevices] = useState<DeviceSessionInfo[]>([]);
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptState>>(new Map());
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);

  // Guards against applying an event twice if the same seq arrives from both a
  // live push and an overlapping replay.
  const appliedSeq = useRef(new Map<string, Set<number>>());

  useEffect(() => {
    const offs = [
      client.on('connection', (state, detail) => {
        setConnection(state);
        setConnectionDetail(detail);
      }),

      client.on('sessions', (incoming) => {
        setSessions((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const s of incoming) byId.set(s.id, s);
          return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        });
      }),

      client.on('sessionRemoved', (sessionId) => {
        // `sessions` merges by id and never drops, so removal has to be explicit.
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setTranscripts((prev) => {
          if (!prev.has(sessionId)) return prev;
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
        appliedSeq.current.delete(sessionId);
      }),

      client.on('projects', setProjects),
      client.on('devices', setDevices),

      client.on('sessionEvent', (sessionId, seq, message) => {
        let seen = appliedSeq.current.get(sessionId);
        if (!seen) {
          seen = new Set();
          appliedSeq.current.set(sessionId, seen);
        }
        if (seen.has(seq)) return;
        seen.add(seq);

        setTranscripts((prev) => {
          const next = new Map(prev);
          const current = next.get(sessionId) ?? emptyTranscript();
          next.set(sessionId, reduceEvent(current, seq, message));
          return next;
        });
      }),

      client.on('replay', (sessionId, phase, detail) => {
        if (phase !== 'end' || !detail.truncated) return;
        setTranscripts((prev) => {
          const next = new Map(prev);
          const current = next.get(sessionId) ?? emptyTranscript();
          next.set(sessionId, { ...current, truncated: true });
          return next;
        });
      }),

      client.on('error', (code, message) => setLastError({ code, message })),
    ];

    client.connect();

    const wake = (): void => {
      if (document.visibilityState === 'visible') client.reconnectNow();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);

    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      for (const off of offs) off();
      client.disconnect();
    };
  }, [client]);

  const clearError = useCallback(() => setLastError(null), []);

  return {
    client,
    connection,
    ...(connectionDetail !== undefined ? { connectionDetail } : {}),
    sessions,
    projects,
    devices,
    transcripts,
    lastError,
    clearError,
  };
}
