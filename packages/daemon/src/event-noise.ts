/**
 * Which agent messages are per-frame progress rather than conversation.
 *
 * The CLI emits a steady stream of these while a turn runs: `system/thinking_tokens`
 * on every thinking frame, `tool_progress` about once a second per running tool,
 * thinking deltas token by token. Nothing consumes them — the transcript builds
 * thinking from the final assistant message, and session status is derived from the
 * message stream before this filter runs — so forwarding them cost phone bandwidth
 * and, worse, pushed real messages out of the event log's ring buffer. That is what
 * made a long turn come back with a "this history has a gap" banner, and what filled
 * the conversation with repeated "thinking tokens" lines.
 *
 * Text deltas are deliberately not noise: they are the live typing the phone shows.
 */
export function isProgressNoise(message: unknown): boolean {
  const m = message as
    | { type?: string; subtype?: string; event?: { delta?: { type?: string } } }
    | null
    | undefined;
  if (!m) return false;

  if (m.type === 'stream_event') {
    const delta = m.event?.delta?.type;
    return delta === 'thinking_delta' || delta === 'signature_delta';
  }

  if (m.type === 'tool_progress' || m.type === 'keep_alive') return true;

  if (m.type === 'system') {
    return PROGRESS_SUBTYPES.has(m.subtype ?? '');
  }

  return false;
}

const PROGRESS_SUBTYPES = new Set([
  'thinking_tokens',
  'status',
  'task_progress',
  'hook_progress',
  'session_state_changed',
]);
