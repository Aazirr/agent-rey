/**
 * Progress frames must not reach the event log.
 *
 * The bug this guards was visible two ways at once: the conversation filled with
 * repeated "thinking tokens" lines, and long turns replayed with a history gap
 * because the ring buffer had been spent on frames nothing renders.
 *
 * Run: node --experimental-strip-types --test test/event-noise.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProgressNoise } from '../src/event-noise.ts';

test('per-frame progress is dropped', () => {
  const noise = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 64, estimated_tokens_delta: 8 },
    { type: 'system', subtype: 'status' },
    { type: 'system', subtype: 'task_progress' },
    { type: 'system', subtype: 'hook_progress' },
    { type: 'system', subtype: 'session_state_changed' },
    { type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 3 },
    { type: 'keep_alive' },
    { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { type: 'stream_event', event: { delta: { type: 'signature_delta' } } },
  ];
  for (const m of noise) {
    assert.equal(isProgressNoise(m), true, JSON.stringify(m));
  }
});

test('conversation is kept', () => {
  const keep = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user', message: { role: 'user', content: 'do it' } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Bash' },
    // Live typing: the phone streams this into the bubble.
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'he' } } },
    undefined,
  ];
  for (const m of keep) {
    assert.equal(isProgressNoise(m), false, JSON.stringify(m ?? null));
  }
});
