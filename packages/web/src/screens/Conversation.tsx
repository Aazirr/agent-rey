/**
 * The conversation view.
 *
 * Interrupt is a permanent, always-reachable control rather than something hidden
 * behind a menu — with unattended permission modes it is the primary safeguard
 * (docs/decisions.md D-004), so it must be one thumb away at all times.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelChoice, PermissionMode, SessionInfo } from '@agent-rey/shared';
import { isUnattendedMode } from '@agent-rey/shared';
import type { ReyClient } from '../lib/client.js';
import type { TranscriptState } from '../lib/transcript.js';
import { emptyTranscript } from '../lib/transcript.js';
import { ToolCard } from '../components/ToolCard.js';
import { StatusPill } from '../components/StatusPill.js';
import { FileViewer } from '../components/FileViewer.js';
import { ProjectDiffSheet } from '../components/ProjectDiffSheet.js';
import { RewindSheet } from '../components/RewindSheet.js';
import { PERMISSION_MODES } from '../lib/modes.js';

export function Conversation({
  session,
  transcript = emptyTranscript(),
  client,
  connected,
  onBack,
}: {
  session: SessionInfo;
  // Explicitly `| undefined`: exactOptionalPropertyTypes distinguishes "absent"
  // from "present but undefined", and the caller passes a Map lookup.
  transcript?: TranscriptState | undefined;
  client: ReyClient;
  connected: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  // Reasoning is off by default: on a phone-width transcript a long turn's
  // thinking blocks push the actual answer off the screen. Remembered per device
  // so someone who wants to read along does not re-enable it every session.
  const [showThinking, setShowThinking] = useState(readShowThinking);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Fetch the model list once per live session. It comes from the CLI, so it
  // reflects what this account may actually use rather than a hardcoded list.
  useEffect(() => {
    if (!connected || session.status === 'exited') return;
    const off = client.on('models', (sessionId, list) => {
      if (sessionId === session.id) setModels(list);
    });
    client.listModels(session.id);
    return off;
  }, [client, session.id, session.status, connected]);

  // Only autoscroll when the user was already at the bottom; yanking the view
  // while they are reading earlier output is worse than not scrolling.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [transcript.items.length, transcript.streaming]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const busy = session.status === 'thinking' || session.status === 'interrupting';
  const thinkingCount = transcript.items.reduce((n, i) => (i.kind === 'thinking' ? n + 1 : n), 0);
  const visibleItems = showThinking ? transcript.items : transcript.items.filter((i) => i.kind !== 'thinking');

  function toggleThinking(): void {
    setShowThinking((prev) => {
      writeShowThinking(!prev);
      return !prev;
    });
  }

  function send(): void {
    const text = draft.trim();
    if (!text || !connected) return;
    client.prompt(session.id, text);
    setDraft('');
    pinnedToBottom.current = true;
  }

  return (
    <div className="conversation">
      <header className="topbar">
        <button className="iconbutton" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="topbar__heading">
          <span className="topbar__title">{session.title ?? session.projectName}</span>
          <span className="topbar__sub">
            {session.projectPath}
            {session.costUsd ? ` · $${session.costUsd.toFixed(3)}` : ''}
          </span>
        </div>
        <StatusPill status={session.status} />
      </header>

      <div className="modebar">
        <select
          className="modebar__select"
          value={session.permissionMode}
          onChange={(e) => client.setPermissionMode(session.id, e.target.value as PermissionMode)}
          disabled={!connected}
          aria-label="Permission mode"
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {models.length > 0 && (
          <select
            className="modebar__select"
            value={session.model ?? ''}
            onChange={(e) => client.setModel(session.id, e.target.value || undefined)}
            disabled={!connected}
            aria-label="Model"
          >
            <option value="">Default model</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        {isUnattendedMode(session.permissionMode) && (
          <span className="modebar__warn" title="This session can act without asking">
            unattended
          </span>
        )}
        <button
          className="linkbutton modebar__diff"
          onClick={() => setDiffOpen(true)}
          disabled={!connected}
          title="Review uncommitted changes in this project"
        >
          Changes
        </button>
        {thinkingCount > 0 && (
          <button
            className="linkbutton"
            onClick={toggleThinking}
            title="Show or hide the model's reasoning"
          >
            {showThinking ? 'Hide thinking' : `Thinking (${thinkingCount})`}
          </button>
        )}
        {session.checkpointing && (
          <button
            className="linkbutton"
            onClick={() => setRewindOpen(true)}
            disabled={!connected}
            title="Restore files to an earlier point in this session"
          >
            Rewind…
          </button>
        )}
      </div>

      <div className="transcript" ref={scrollRef} data-testid="transcript">
        {transcript.truncated && (
          <p className="alert alert--info">
            Some earlier messages are no longer available on the daemon, so this history has a gap.
          </p>
        )}

        {visibleItems.length === 0 && !transcript.streaming && (
          <p className="muted transcript__empty">
            {session.status === 'exited'
              ? 'This session is not running. Send a message to resume it.'
              : 'No messages yet. Send something.'}
          </p>
        )}

        {visibleItems.map((item) => {
          switch (item.kind) {
            case 'text':
              return (
                <div key={item.id} className={`bubble bubble--${item.role}`}>
                  {item.text}
                </div>
              );
            case 'thinking':
              return (
                <details key={item.id} className="thinking">
                  <summary>Thinking</summary>
                  <pre>{item.text}</pre>
                </details>
              );
            case 'tool':
              return <ToolCard key={item.id} item={item} onViewFile={setViewingFile} />;
            case 'result':
              return (
                <div key={item.id} className={`result ${item.isError ? 'result--error' : ''}`}>
                  {item.isError ? 'Turn ended with an error' : 'Turn complete'}
                  {item.costUsd !== undefined && ` · $${item.costUsd.toFixed(4)}`}
                  {item.durationMs !== undefined && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
                  {item.subtype && item.subtype !== 'success' && ` · ${item.subtype.replace(/_/g, ' ')}`}
                </div>
              );
            case 'notice':
              return (
                <p key={item.id} className={`alert alert--${item.level === 'error' ? 'error' : 'info'}`}>
                  {item.text}
                </p>
              );
          }
        })}

        {transcript.streaming && <div className="bubble bubble--assistant bubble--streaming">{transcript.streaming}</div>}
      </div>

      <footer className="composer">
        <textarea
          className="composer__input"
          data-testid="composer-input"
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends on a physical keyboard; on a phone the soft keyboard's
            // newline is more useful, so only plain Enter without shift sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={connected ? 'Message…' : 'Reconnecting…'}
          rows={1}
          disabled={!connected}
        />
        {busy ? (
          <button
            className="button button--danger composer__action"
            onClick={() => client.interrupt(session.id)}
            disabled={!connected}
          >
            Stop
          </button>
        ) : (
          <button
            className="button button--primary composer__action"
            onClick={send}
            disabled={!connected || draft.trim() === ''}
          >
            Send
          </button>
        )}
      </footer>

      {viewingFile && (
        <FileViewer
          client={client}
          sessionId={session.id}
          path={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}

      {rewindOpen && (
        <RewindSheet
          client={client}
          sessionId={session.id}
          checkpointing={session.checkpointing}
          onClose={() => setRewindOpen(false)}
        />
      )}

      {diffOpen && (
        <ProjectDiffSheet client={client} sessionId={session.id} onClose={() => setDiffOpen(false)} />
      )}

    </div>
  );
}

const SHOW_THINKING_KEY = 'rey.showThinking';

function readShowThinking(): boolean {
  try {
    return localStorage.getItem(SHOW_THINKING_KEY) === '1';
  } catch {
    // Private-mode Safari throws on storage access; the default is fine.
    return false;
  }
}

function writeShowThinking(value: boolean): void {
  try {
    localStorage.setItem(SHOW_THINKING_KEY, value ? '1' : '0');
  } catch {
    /* not worth failing a render over */
  }
}
