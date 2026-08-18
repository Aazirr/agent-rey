/**
 * A tool call, collapsed to one line by default.
 *
 * Expanded tool output is the single biggest source of noise on a small screen, so
 * the default is a headline the user can scan: what tool, on what, did it work.
 */

import { useMemo, useState } from 'react';
import type { ToolItem } from '../lib/transcript.js';
import { summarizeToolInput, filePathFromTool } from '../lib/transcript.js';
import { truncate } from '../lib/format.js';
import { diffLines, editPairFromTool } from '../lib/diff.js';
import { DiffView } from './DiffView.js';

const STATUS_GLYPH: Record<ToolItem['status'], string> = {
  pending: '⋯',
  ok: '✓',
  error: '✕',
};

export function ToolCard({
  item,
  onViewFile,
}: {
  item: ToolItem;
  onViewFile?: (path: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(item.name, item.input);
  const filePath = filePathFromTool(item.name, item.input);

  // An Edit already carries old_string/new_string, so the diff of what the agent
  // changed costs nothing extra and works for sessions that have already ended.
  const edit = useMemo(() => {
    const pair = editPairFromTool(item.name, item.input);
    return pair ? diffLines(pair.oldText, pair.newText) : null;
  }, [item.name, item.input]);

  return (
    <div className={`tool tool--${item.status}`}>
      <button className="tool__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`tool__status tool__status--${item.status}`} aria-hidden>
          {STATUS_GLYPH[item.status]}
        </span>
        <span className="tool__name">{item.name}</span>
        {summary && <span className="tool__summary">{truncate(summary, 64)}</span>}
        <span className="tool__chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="tool__body">
          {filePath && onViewFile && (
            <button className="button button--ghost tool__action" onClick={() => onViewFile(filePath)}>
              View file
            </button>
          )}
          {edit && (
            <div className="tool__section">
              <span className="tool__label">{item.name === 'Write' ? 'Contents' : 'Change'}</span>
              <DiffView lines={edit.lines} stat={edit.stat} />
            </div>
          )}
          <div className="tool__section">
            <span className="tool__label">Input</span>
            <pre className="tool__pre">{formatJson(item.input)}</pre>
          </div>
          {item.result !== undefined && item.result !== '' && (
            <div className="tool__section">
              <span className="tool__label">{item.status === 'error' ? 'Error' : 'Result'}</span>
              <pre className="tool__pre">{truncate(item.result, 4000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
