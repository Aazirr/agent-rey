/**
 * Unbounded async queue that adapts "user typed a message" into the
 * `AsyncIterable<SDKUserMessage>` the SDK wants for streaming input mode.
 *
 * Streaming input mode is required, not optional: it is the only mode where
 * `interrupt()`, `setPermissionMode()`, and `setModel()` work. Since the whole
 * point is driving a live session from a phone, everything goes through here.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  #done = false;

  /**
   * @param uuid Assigned by the caller so the daemon knows the id of the message
   *   it submitted — needed both to echo the message into the transcript and as
   *   the anchor for a later rewind.
   */
  push(text: string, uuid?: string): void {
    if (this.#done) throw new Error('PromptQueue is closed');
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    // Assigned rather than spread: under exactOptionalPropertyTypes an optional
    // property cannot be set to `string | undefined` via a conditional spread.
    if (uuid) message.uuid = uuid as NonNullable<SDKUserMessage['uuid']>;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ value: message, done: false });
    } else {
      this.#pending.push(message);
    }
  }

  /** Ends the stream; the SDK treats this as "no more user input". */
  close(): void {
    if (this.#done) return;
    this.#done = true;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.#done;
  }

  get depth(): number {
    return this.#pending.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const buffered = this.#pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.#done) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
