/**
 * Line diff, used two ways: rendering an `Edit` tool call's before/after inline in
 * the transcript, and rendering a unified patch the daemon got from git.
 *
 * An `Edit` already carries `old_string` and `new_string`, so showing what actually
 * changed costs nothing extra — no round trip, and it works for sessions that have
 * already ended.
 *
 * The algorithm is a standard LCS over lines. Inputs here are edit hunks and file
 * patches, not whole repositories, so O(n·m) is fine; `MAX_LINES` caps the
 * pathological case rather than letting a huge input freeze the phone.
 */

export type DiffOp = 'context' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text; absent for additions. */
  oldLine?: number;
  /** 1-based line number in the new text; absent for removals. */
  newLine?: number;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  /** True when the input was too large and the diff was skipped. */
  truncated: boolean;
}

const MAX_LINES = 2000;

export function diffLines(oldText: string, newText: string): { lines: DiffLine[]; stat: DiffStat } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      lines: [],
      stat: { additions: 0, deletions: 0, truncated: true },
    };
  }

  // LCS table over lines.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'context', text: a[i]!, oldLine: oldLine++, newLine: newLine++ });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ op: 'remove', text: a[i]!, oldLine: oldLine++ });
      deletions++;
      i++;
    } else {
      lines.push({ op: 'add', text: b[j]!, newLine: newLine++ });
      additions++;
      j++;
    }
  }
  while (i < a.length) {
    lines.push({ op: 'remove', text: a[i]!, oldLine: oldLine++ });
    deletions++;
    i++;
  }
  while (j < b.length) {
    lines.push({ op: 'add', text: b[j]!, newLine: newLine++ });
    additions++;
    j++;
  }

  return { lines, stat: { additions, deletions, truncated: false } };
}

/**
 * Collapse long runs of unchanged lines, keeping `context` lines either side of
 * each change. On a phone, 200 untouched lines between two edits is noise that
 * pushes the actual change off screen.
 */
export function collapseContext(lines: DiffLine[], context = 3): Array<DiffLine | { op: 'gap'; count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (const [index, line] of lines.entries()) {
    if (line.op === 'context') continue;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true;
    }
  }

  const out: Array<DiffLine | { op: 'gap'; count: number }> = [];
  let skipped = 0;
  for (const [index, line] of lines.entries()) {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ op: 'gap', count: skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push({ op: 'gap', count: skipped });
  return out;
}

/**
 * The before/after of an `Edit`-style tool call, or null when the tool is not one
 * whose diff we can reconstruct.
 */
export function editPairFromTool(
  name: string,
  input: unknown,
): { oldText: string; newText: string; path?: string } | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  const path = typeof obj['file_path'] === 'string' ? (obj['file_path'] as string) : undefined;

  if (name === 'Edit') {
    const oldText = obj['old_string'];
    const newText = obj['new_string'];
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    return { oldText, newText, ...(path ? { path } : {}) };
  }

  // A Write is a whole-file replacement; there is no "before" in the tool input,
  // so it renders as all-additions rather than a misleading diff.
  if (name === 'Write') {
    const content = obj['content'];
    if (typeof content !== 'string') return null;
    return { oldText: '', newText: content, ...(path ? { path } : {}) };
  }

  return null;
}

/** Parse a unified patch (from git) into renderable lines, per file. */
export interface PatchFile {
  path: string;
  lines: DiffLine[];
  stat: DiffStat;
}

export function parseUnifiedPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // `b/path` is the post-image name, which is the one worth showing.
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(raw);
      current = {
        path: match?.[2] ?? match?.[1] ?? 'unknown',
        lines: [],
        stat: { additions: 0, deletions: 0, truncated: false },
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = Number(match?.[1] ?? 1);
      newLine = Number(match?.[2] ?? 1);
      if (current.lines.length > 0) current.lines.push({ op: 'context', text: '' });
      continue;
    }
    // Headers carry no line content.
    if (
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename ') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('Binary files')
    ) {
      continue;
    }

    if (raw.startsWith('+')) {
      current.lines.push({ op: 'add', text: raw.slice(1), newLine: newLine++ });
      current.stat.additions++;
    } else if (raw.startsWith('-')) {
      current.lines.push({ op: 'remove', text: raw.slice(1), oldLine: oldLine++ });
      current.stat.deletions++;
    } else if (raw.startsWith(' ')) {
      current.lines.push({ op: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
    // A `\ No newline at end of file` marker is not a content line.
  }

  return files;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  // Normalise CRLF so a Windows file does not diff as entirely changed.
  const normalised = text.replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  // A trailing newline produces a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
