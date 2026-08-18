/**
 * Renders a line diff. Shared by the inline `Edit` diff on a tool card and the
 * repo-level diff sheet.
 *
 * Long unchanged runs are collapsed — on a phone, 200 untouched lines between two
 * edits pushes the actual change off screen. Colour is never the only signal: every
 * row carries a `+`/`-`/space gutter, so it reads correctly without colour vision.
 */

import { collapseContext, type DiffLine, type DiffStat } from '../lib/diff.js';

const SIGN: Record<DiffLine['op'], string> = {
  add: '+',
  remove: '−',
  context: ' ',
};

export function DiffView({
  lines,
  stat,
  context = 3,
}: {
  lines: DiffLine[];
  stat?: DiffStat;
  context?: number;
}): React.JSX.Element {
  if (stat?.truncated) {
    return <p className="alert alert--info">This change is too large to diff here.</p>;
  }
  if (lines.length === 0) {
    return <p className="muted">No textual changes.</p>;
  }

  const rows = collapseContext(lines, context);

  return (
    <div className="diff" data-testid="diff-view">
      {stat && (
        <div className="diff__stat">
          <span className="diff__stat-add">+{stat.additions}</span>
          <span className="diff__stat-del">−{stat.deletions}</span>
        </div>
      )}
      <pre className="diff__pre">
        {rows.map((row, i) =>
          row.op === 'gap' ? (
            <span key={`gap-${i}`} className="diff__gap">
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </span>
          ) : (
            <span key={`${row.op}-${row.oldLine ?? 'x'}-${row.newLine ?? 'x'}-${i}`} className={`diff__line diff__line--${row.op}`}>
              <span className="diff__num">{row.oldLine ?? ''}</span>
              <span className="diff__num">{row.newLine ?? ''}</span>
              <span className="diff__sign" aria-hidden>
                {SIGN[row.op]}
              </span>
              <span className="diff__text">{row.text || ' '}</span>
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
