/**
 * Unit tests for the transcript reducer.
 *
 * The reducer is where a silent correctness bug would hide: it is pure, it runs on
 * every event, and a mistake shows up as duplicated or missing conversation rather
 * than a crash. Replay-idempotency in particular is load-bearing — reconnects
 * re-deliver events, so applying the same seq twice must be a no-op.
 *
 * Run: node --experimental-strip-types test/transcript.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTranscript,
  reduceEvent,
  summarizeToolInput,
  shortenPath,
  filePathFromTool,
} from '../src/lib/transcript.ts';

const assistantText = (text) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const toolUse = (id, name, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (id, content, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

test('assistant text becomes a bubble', () => {
  const s = reduceEvent(emptyTranscript(), 1, assistantText('hello'));
  assert.equal(s.items.length, 1);
  assert.deepEqual({ kind: s.items[0].kind, role: s.items[0].role, text: s.items[0].text }, {
    kind: 'text',
    role: 'assistant',
    text: 'hello',
  });
});

test('streaming deltas accumulate then are cleared by the real message', () => {
  let s = emptyTranscript();
  s = reduceEvent(s, 1, { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'par' } } });
  s = reduceEvent(s, 2, { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'tial' } } });
  assert.equal(s.streaming, 'partial');
  assert.equal(s.items.length, 0, 'deltas must not create items');

  s = reduceEvent(s, 3, assistantText('partial complete'));
  assert.equal(s.streaming, '', 'streaming buffer must clear or text renders twice');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].text, 'partial complete');
});

test('tool result attaches to its tool_use by id', () => {
  let s = reduceEvent(emptyTranscript(), 1, toolUse('t1', 'Read', { file_path: '/a/b/c.ts' }));
  assert.equal(s.items[0].status, 'pending');

  s = reduceEvent(s, 2, toolResult('t1', 'file contents here'));
  assert.equal(s.items.length, 1, 'result must not create a second item');
  assert.equal(s.items[0].status, 'ok');
  assert.equal(s.items[0].result, 'file contents here');
});

test('tool error is marked as error', () => {
  let s = reduceEvent(emptyTranscript(), 1, toolUse('t1', 'Bash', { command: 'exit 1' }));
  s = reduceEvent(s, 2, toolResult('t1', 'command failed', true));
  assert.equal(s.items[0].status, 'error');
});

test('an unmatched tool result does not corrupt state', () => {
  let s = reduceEvent(emptyTranscript(), 1, toolUse('t1', 'Read', {}));
  s = reduceEvent(s, 2, toolResult('nonexistent', 'stray'));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].status, 'pending', 'the real tool must be untouched');
});

test('array tool_result content is flattened to text', () => {
  let s = reduceEvent(emptyTranscript(), 1, toolUse('t1', 'Grep', { pattern: 'x' }));
  s = reduceEvent(s, 2, toolResult('t1', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]));
  assert.equal(s.items[0].result, 'line one\nline two');
});

test('reducing is pure — input state is never mutated', () => {
  const before = reduceEvent(emptyTranscript(), 1, assistantText('first'));
  const snapshot = JSON.stringify(before);
  reduceEvent(before, 2, assistantText('second'));
  assert.equal(JSON.stringify(before), snapshot, 'reduceEvent must not mutate its argument');
});

test('replaying the same events produces identical state', () => {
  const events = [
    [1, assistantText('working on it')],
    [2, toolUse('t1', 'Edit', { file_path: '/x/y.ts' })],
    [3, toolResult('t1', 'ok')],
    [4, { type: 'result', total_cost_usd: 0.012, duration_ms: 3400, subtype: 'success' }],
  ];
  const run = () => events.reduce((s, [seq, ev]) => reduceEvent(s, seq, ev), emptyTranscript());
  assert.deepEqual(run(), run(), 'replay must be deterministic');
});

test('result event records cost and duration', () => {
  const s = reduceEvent(emptyTranscript(), 1, {
    type: 'result',
    total_cost_usd: 0.25,
    duration_ms: 1500,
    is_error: false,
  });
  assert.equal(s.items[0].kind, 'result');
  assert.equal(s.items[0].costUsd, 0.25);
  assert.equal(s.items[0].durationMs, 1500);
  assert.equal(s.items[0].isError, false);
});

test('daemon-synthesized errors surface as notices', () => {
  const s = reduceEvent(emptyTranscript(), 1, { type: 'rey_error', error: 'spawn failed' });
  assert.equal(s.items[0].kind, 'notice');
  assert.equal(s.items[0].level, 'error');
  assert.match(s.items[0].text, /spawn failed/);
});

test('only system subtypes worth reading become notices', () => {
  const init = reduceEvent(emptyTranscript(), 1, { type: 'system', subtype: 'init' });
  assert.equal(init.items.length, 0, 'init is noise on a phone');

  // The regression this guards: `thinking_tokens` fires on every thinking frame,
  // so surfacing unknown subtypes buried the conversation under identical lines.
  const thinking = reduceEvent(emptyTranscript(), 1, {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 128,
    estimated_tokens_delta: 8,
  });
  assert.equal(thinking.items.length, 0, 'per-frame progress is not transcript content');

  const compact = reduceEvent(emptyTranscript(), 1, { type: 'system', subtype: 'compact_boundary' });
  assert.equal(compact.items.length, 1);
  assert.match(compact.items[0].text, /compacted/i);

  const denied = reduceEvent(emptyTranscript(), 1, {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    decision_reason: 'deny rule',
  });
  assert.equal(denied.items[0].level, 'error');
  assert.match(denied.items[0].text, /Bash: deny rule/);

  const hookFeedback = reduceEvent(emptyTranscript(), 1, {
    type: 'system',
    subtype: 'informational',
    level: 'warning',
    content: 'a hook blocked that',
  });
  assert.equal(hookFeedback.items[0].text, 'a hook blocked that');
  assert.equal(hookFeedback.items[0].level, 'error');

  const chatter = reduceEvent(emptyTranscript(), 1, {
    type: 'system',
    subtype: 'informational',
    level: 'info',
    content: 'transcript-mode detail',
  });
  assert.equal(chatter.items.length, 0);
});

test('user text is captured and rewind target tracked', () => {
  const s = reduceEvent(emptyTranscript(), 1, {
    type: 'user',
    uuid: 'u-123',
    message: { role: 'user', content: 'do the thing' },
  });
  assert.equal(s.items[0].role, 'user');
  assert.equal(s.items[0].text, 'do the thing');
  assert.equal(s.lastUserMessageId, 'u-123');
});

test('unknown message types are ignored, not crashed on', () => {
  const s = reduceEvent(emptyTranscript(), 1, { type: 'some_future_type', payload: {} });
  assert.deepEqual(s.items, []);
});

test('summarizeToolInput picks the meaningful field per tool', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(summarizeToolInput('Read', { file_path: '/a/b/c/d.ts' }), '…/c/d.ts');
  assert.equal(summarizeToolInput('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(summarizeToolInput('TodoWrite', { todos: [] }), 'update task list');
  assert.equal(summarizeToolInput('MysteryTool', { thing: 'value' }), 'value');
  assert.equal(summarizeToolInput('Anything', {}), '');
});

test('shortenPath keeps the tail, which is what matters on a phone', () => {
  assert.equal(shortenPath('C:\\Users\\me\\proj\\src\\index.ts'), '…/src/index.ts');
  assert.equal(shortenPath('src/index.ts'), 'src/index.ts');
});

test('filePathFromTool offers a file only for tools that act on one', () => {
  assert.equal(filePathFromTool('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(filePathFromTool('Write', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(filePathFromTool('Edit', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(filePathFromTool('NotebookEdit', { notebook_path: '/a/n.ipynb' }), '/a/n.ipynb');

  // A "view file" action on these would do nothing useful.
  assert.equal(filePathFromTool('Bash', { command: 'ls /a/b.ts' }), null);
  assert.equal(filePathFromTool('Grep', { pattern: 'x', path: '/a' }), null);
  assert.equal(filePathFromTool('WebFetch', { url: 'https://x.dev' }), null);
});

test('filePathFromTool tolerates malformed input', () => {
  assert.equal(filePathFromTool('Read', {}), null);
  assert.equal(filePathFromTool('Read', undefined), null);
  assert.equal(filePathFromTool('Read', { file_path: '' }), null);
  assert.equal(filePathFromTool('Read', { file_path: 42 }), null);
});
