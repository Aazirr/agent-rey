/**
 * Reduces the raw SDK message stream into renderable transcript items.
 *
 * The daemon forwards SDK messages verbatim (docs/decisions.md D-006), so all
 * interpretation happens here. Strategy:
 *
 *  - `assistant` / `user` messages are the source of truth for content
 *  - `stream_event` deltas only drive a live "currently typing" buffer, which is
 *    discarded as soon as the real `assistant` message lands. Trying to build the
 *    transcript from deltas alone means reimplementing block assembly and getting
 *    it subtly wrong on every reconnect.
 *  - tool calls are matched to their results by `tool_use_id`, so a card can show
 *    pending → done/error rather than two disconnected entries.
 *
 * Reducing is pure and idempotent per seq, which is what lets a replayed gap be
 * applied with no special casing.
 */

export type ToolStatus = 'pending' | 'ok' | 'error';

export interface TextItem {
  kind: 'text';
  id: string;
  role: 'assistant' | 'user';
  text: string;
  /**
   * The agent's uuid for this user message. Present on user messages only, and
   * only when the CLI supplied one — it is the rewind target, so each user turn
   * needs its own rather than sharing a single "most recent" value.
   */
  messageId?: string;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  text: string;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: string;
}

export interface ResultItem {
  kind: 'result';
  id: string;
  costUsd?: number;
  durationMs?: number;
  isError: boolean;
  subtype?: string;
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  level: 'info' | 'error';
  text: string;
}

export type TranscriptItem = TextItem | ThinkingItem | ToolItem | ResultItem | NoticeItem;

export interface TranscriptState {
  items: TranscriptItem[];
  /** Partial assistant text for the in-flight turn; not yet an item. */
  streaming: string;
  /** Set when a replay reported a gap, so the UI can say so honestly. */
  truncated: boolean;
  /** Most recent user message uuid, used as the rewind target. */
  lastUserMessageId?: string;
}

export function emptyTranscript(): TranscriptState {
  return { items: [], streaming: '', truncated: false };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  error?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  /* Fields carried by the `system` subtypes that earn a notice. */
  content?: string;
  text?: string;
  level?: string;
  tool_name?: string;
  decision_reason?: string;
}

/** Apply one event. Returns a new state; never mutates the input. */
export function reduceEvent(state: TranscriptState, seq: number, raw: unknown): TranscriptState {
  const msg = raw as RawMessage;

  switch (msg.type) {
    case 'stream_event': {
      const delta = msg.event?.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return { ...state, streaming: state.streaming + delta.text };
      }
      // Thinking deltas are deliberately not streamed into the bubble; they land
      // as a collapsed item when the assistant message arrives.
      return state;
    }

    case 'assistant': {
      const blocks = normalizeBlocks(msg.message?.content);
      const additions: TranscriptItem[] = [];
      for (const [i, block] of blocks.entries()) {
        if (block.type === 'text' && block.text?.trim()) {
          additions.push({ kind: 'text', id: `${seq}:${i}`, role: 'assistant', text: block.text });
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          additions.push({ kind: 'thinking', id: `${seq}:${i}`, text: block.thinking });
        } else if (block.type === 'tool_use') {
          additions.push({
            kind: 'tool',
            id: block.id ?? `${seq}:${i}`,
            name: block.name ?? 'unknown',
            input: block.input,
            status: 'pending',
          });
        }
      }
      // Clearing `streaming` here is what keeps text from appearing twice.
      return { ...state, items: [...state.items, ...additions], streaming: '' };
    }

    case 'user': {
      const blocks = normalizeBlocks(msg.message?.content);
      let items = state.items;
      const additions: TranscriptItem[] = [];

      for (const [i, block] of blocks.entries()) {
        if (block.type === 'tool_result') {
          const toolId = block.tool_use_id;
          const text = stringifyToolResult(block.content);
          items = items.map((item) =>
            item.kind === 'tool' && item.id === toolId
              ? { ...item, status: block.is_error ? 'error' : 'ok', result: text }
              : item,
          );
        } else if (block.type === 'text' && block.text?.trim()) {
          additions.push({
            kind: 'text',
            id: `${seq}:${i}`,
            role: 'user',
            text: block.text,
            // Carried per-message so any user turn can be a rewind target.
            ...(msg.uuid ? { messageId: msg.uuid } : {}),
          });
        }
      }

      const next: TranscriptState = {
        ...state,
        items: additions.length > 0 ? [...items, ...additions] : items,
      };
      if (msg.uuid) next.lastUserMessageId = msg.uuid;
      return next;
    }

    case 'result': {
      const item: ResultItem = {
        kind: 'result',
        id: `${seq}:result`,
        isError: msg.is_error === true,
      };
      if (typeof msg.total_cost_usd === 'number') item.costUsd = msg.total_cost_usd;
      if (typeof msg.duration_ms === 'number') item.durationMs = msg.duration_ms;
      if (msg.subtype) item.subtype = msg.subtype;
      return { ...state, items: [...state.items, item], streaming: '' };
    }

    case 'rey_error': {
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'notice', id: `${seq}:err`, level: 'error', text: msg.error ?? 'daemon error' },
        ],
        streaming: '',
      };
    }

    case 'system': {
      const notice = noticeFromSystem(msg, seq);
      return notice ? { ...state, items: [...state.items, notice] } : state;
    }

    default:
      return state;
  }
}

/**
 * Which `system` subtypes earn a line in the transcript.
 *
 * A whitelist, deliberately. The CLI emits a large family of system messages and
 * most of them are per-frame progress — `thinking_tokens` alone fires on every
 * thinking frame — so treating "any subtype but init" as a notice buried the real
 * conversation under an endless run of "thinking tokens" lines. A subtype belongs
 * here only when a human reading the conversation later would want to see it.
 */
function noticeFromSystem(msg: RawMessage, seq: number): NoticeItem | null {
  const id = `${seq}:sys`;
  switch (msg.subtype) {
    case 'compact_boundary':
      return { kind: 'notice', id, level: 'info', text: 'Context compacted to keep the session going.' };

    case 'permission_denied':
      return {
        kind: 'notice',
        id,
        level: 'error',
        text: `Denied ${msg.tool_name ?? 'a tool call'}${msg.decision_reason ? `: ${msg.decision_reason}` : ''}`,
      };

    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback':
      return { kind: 'notice', id, level: 'error', text: msg.content ?? 'The model refused this turn.' };

    case 'informational':
      // Level `info` is transcript-mode detail inside the CLI itself; anything
      // louder is hook feedback or slash-command output, which the sender wants.
      if (msg.level && msg.level !== 'info' && msg.content) {
        return { kind: 'notice', id, level: msg.level === 'warning' ? 'error' : 'info', text: msg.content };
      }
      return null;

    case 'notification':
      return msg.text ? { kind: 'notice', id, level: 'info', text: msg.text } : null;

    default:
      return null;
  }
}

function normalizeBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as ContentBlock;
        if (block.type === 'text') return block.text ?? '';
        return `[${block.type ?? 'block'}]`;
      })
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** One-line summary of a tool call for the collapsed card header. */
export function summarizeToolInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined);

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortenPath(pick('file_path') ?? pick('path') ?? '');
    case 'Bash':
      return pick('command') ?? '';
    case 'Grep':
      return pick('pattern') ?? '';
    case 'Glob':
      return pick('pattern') ?? '';
    case 'WebFetch':
      return pick('url') ?? '';
    case 'Task':
    case 'Agent':
      return pick('description') ?? '';
    case 'TodoWrite':
      return 'update task list';
    default: {
      const first = Object.values(obj).find((v) => typeof v === 'string') as string | undefined;
      return first ?? '';
    }
  }
}

/**
 * The file a tool call operated on, if it operated on one. Used to offer a
 * "view file" action on the tool card — only for tools whose subject genuinely is
 * a single file, so the action never appears where it would do nothing useful.
 */
export function filePathFromTool(name: string, input: unknown): string | null {
  if (!['Read', 'Write', 'Edit', 'NotebookEdit'].includes(name)) return null;
  const obj = (input ?? {}) as Record<string, unknown>;
  const path = obj['file_path'] ?? obj['path'] ?? obj['notebook_path'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** Keep the tail of a path — on a phone the filename matters, the prefix does not. */
export function shortenPath(p: string, maxSegments = 2): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= maxSegments) return parts.join('/');
  return `…/${parts.slice(-maxSegments).join('/')}`;
}
