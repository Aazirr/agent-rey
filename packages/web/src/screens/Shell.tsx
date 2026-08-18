/**
 * Authenticated app shell: session list ⇄ conversation.
 *
 * Single-pane by design — this is a phone first. The desktop gets the same layout
 * widened rather than a second column, because a second column would be dead space
 * on the device that matters.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PermissionMode } from '@agent-rey/shared';
import { useReyClient } from '../hooks/useReyClient.js';
import { Conversation } from './Conversation.js';
import { Home } from './Home.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import { ProjectSessionsSheet } from '../components/ProjectSessionsSheet.js';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { DevicesSheet } from '../components/DevicesSheet.js';
import { clearToken } from '../lib/auth.js';

export function Shell({
  daemonUrl,
  token,
  onSignedOut,
}: {
  daemonUrl: string;
  token: string;
  onSignedOut: (reason?: string) => void;
}): React.JSX.Element {
  const rey = useReyClient(daemonUrl, token);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState<{ projectPath?: string } | null>(null);
  const [showDevices, setShowDevices] = useState(false);
  /** Which project's session list is open, if any. */
  const [browsingProject, setBrowsingProject] = useState<string | null>(null);

  const browsedProject = useMemo(
    () => rey.projects.find((p) => p.path === browsingProject) ?? null,
    [rey.projects, browsingProject],
  );

  // A dead token cannot be recovered by retrying, so bounce to login.
  useEffect(() => {
    if (rey.connection === 'unauthorized') {
      clearToken();
      onSignedOut(rey.connectionDetail ?? 'Your session expired. Sign in again.');
    }
  }, [rey.connection, rey.connectionDetail, onSignedOut]);

  useEffect(() => {
    if (rey.connection !== 'open') return;
    rey.client.listProjects();
    rey.client.listSessions();
  }, [rey.connection, rey.client]);

  // Subscribing is what triggers gap replay, so it must follow every (re)connect.
  useEffect(() => {
    if (!activeId || rey.connection !== 'open') return;
    rey.client.subscribe(activeId);
  }, [activeId, rey.connection, rey.client]);

  const active = useMemo(
    () => rey.sessions.find((s) => s.id === activeId) ?? null,
    [rey.sessions, activeId],
  );

  const openSession = useCallback(
    (id: string) => {
      const session = rey.sessions.find((s) => s.id === id);
      // An exited session must be resumed before it can accept a prompt.
      if (session && session.status === 'exited') rey.client.resumeSession(id);
      setActiveId(id);
    },
    [rey.client, rey.sessions],
  );

  const startSession = useCallback(
    (opts: {
      projectPath: string;
      permissionMode: PermissionMode;
      prompt?: string;
    }) => {
      rey.client.startSession(opts);
      setShowNew(null);
    },
    [rey.client],
  );

  // Open the session the daemon says it just created — NOT the most recently
  // active one. Another session mid-turn has newer activity and would win the sort,
  // so sorting to find "the new session" opens the wrong conversation.
  const [awaitingNewSession, setAwaitingNewSession] = useState(false);
  useEffect(() => {
    if (!awaitingNewSession) return;
    return rey.client.on('sessionCreated', (session) => {
      setActiveId(session.id);
      setAwaitingNewSession(false);
    });
  }, [awaitingNewSession, rey.client]);

  return (
    <div className="app">
      <ConnectionBanner state={rey.connection} {...(rey.connectionDetail ? { detail: rey.connectionDetail } : {})} />

      {active ? (
        <Conversation
          session={active}
          transcript={rey.transcripts.get(active.id)}
          client={rey.client}
          connected={rey.connection === 'open'}
          onBack={() => setActiveId(null)}
        />
      ) : (
        <Home
          sessions={rey.sessions}
          projects={rey.projects}
          onOpenProject={setBrowsingProject}
          onNewSession={() => setShowNew({})}
          onRefreshProjects={() => rey.client.listProjects(true)}
          onShowDevices={() => {
            rey.client.listDevices();
            setShowDevices(true);
          }}
          onSignOut={() => {
            clearToken();
            onSignedOut();
          }}
        />
      )}

      {browsedProject && (
        <ProjectSessionsSheet
          project={browsedProject}
          sessions={rey.sessions}
          client={rey.client}
          onOpenSession={(id) => {
            openSession(id);
            setBrowsingProject(null);
          }}
          onContinueExternal={(externalId) => {
            setAwaitingNewSession(true);
            rey.client.startSession({
              projectPath: browsedProject.path,
              // Stays attended by default: a forked desk session should not
              // silently gain permission to act on its own.
              permissionMode: 'default',
              forkFromExternalId: externalId,
            });
            setBrowsingProject(null);
          }}
          onNewSession={() => {
            setShowNew({ projectPath: browsedProject.path });
            setBrowsingProject(null);
          }}
          onDeleteSessions={(ids) => {
            for (const id of ids) rey.client.deleteSession(id);
            // Do not strand the user in a conversation that no longer exists.
            if (activeId && ids.includes(activeId)) setActiveId(null);
          }}
          onClose={() => setBrowsingProject(null)}
        />
      )}

      {showNew && (
        <NewSessionSheet
          projects={rey.projects}
          {...(showNew.projectPath ? { initialProjectPath: showNew.projectPath } : {})}
          onClose={() => setShowNew(null)}
          onStart={(opts) => {
            setAwaitingNewSession(true);
            startSession(opts);
          }}
        />
      )}

      {showDevices && (
        <DevicesSheet
          devices={rey.devices}
          onRevoke={(id) => rey.client.revokeDevice(id)}
          onClose={() => setShowDevices(false)}
        />
      )}

      {rey.lastError && (
        <div className="toast" role="alert" onClick={rey.clearError}>
          <strong>{rey.lastError.code.replace(/_/g, ' ')}</strong>
          <span>{rey.lastError.message}</span>
        </div>
      )}
    </div>
  );
}
