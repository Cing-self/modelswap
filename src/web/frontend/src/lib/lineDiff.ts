// Line-level LCS diff used by the config-snapshot viewer. Produces git-style
// ops (context / added / deleted lines with 1-based line numbers on both
// sides) plus hunk grouping with surrounding context, mirroring `git diff`
// output closely enough for a review UI.

export type DiffOp = {
  type: 'ctx' | 'add' | 'del';
  /** 1-based line number in the old (snapshot) file; 0 when absent. */
  aNum: number;
  /** 1-based line number in the new (current) file; 0 when absent. */
  bNum: number;
  text: string;
};

export type DiffHunk = {
  aStart: number;
  bStart: number;
  ops: DiffOp[];
};

export type DiffResult = {
  ops: DiffOp[];
  hunks: DiffHunk[];
  adds: number;
  dels: number;
};

function splitLines(s: string): string[] {
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(aText: string, bText: string, context = 3): DiffResult {
  const a = splitLines(aText ?? '');
  const b = splitLines(bText ?? '');
  const n = a.length;
  const m = b.length;

  // LCS length table, computed bottom-up. Config files are at most a few
  // thousand lines, so O(n*m) with Uint32 rows is well within budget.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let adds = 0;
  let dels = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', aNum: i + 1, bNum: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', aNum: i + 1, bNum: 0, text: a[i] });
      i++;
      dels++;
    } else {
      ops.push({ type: 'add', aNum: 0, bNum: j + 1, text: b[j] });
      j++;
      adds++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', aNum: i + 1, bNum: 0, text: a[i] });
    i++;
    dels++;
  }
  while (j < m) {
    ops.push({ type: 'add', aNum: 0, bNum: j + 1, text: b[j] });
    j++;
    adds++;
  }

  return { ops, hunks: groupHunks(ops, context), adds, dels };
}

function groupHunks(ops: DiffOp[], context: number): DiffHunk[] {
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'ctx') changeIdx.push(idx);
  });
  if (changeIdx.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length - 1, changeIdx[0] + context);

  const flush = (from: number, to: number) => {
    const slice = ops.slice(from, to + 1);
    const first = slice.find(o => o.aNum > 0) ?? slice[0];
    const firstB = slice.find(o => o.bNum > 0) ?? slice[0];
    hunks.push({ aStart: first.aNum || 1, bStart: firstB.bNum || 1, ops: slice });
  };

  for (const idx of changeIdx.slice(1)) {
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      flush(start, end);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  flush(start, end);
  return hunks;
}
