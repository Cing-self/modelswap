import { describe, it, expect } from 'vitest';
import { diffLines } from '../../src/web/frontend/src/lib/lineDiff';

const A = ['{', '  "a": 1,', '  "old": 2,', '  "c": 3', '}'].join('\n');
const B = ['{', '  "a": 1,', '  "new": 2,', '  "extra": 9,', '  "c": 3', '}'].join('\n');

describe('diffLines', () => {
  it('counts additions and deletions across a replaced block', () => {
    const d = diffLines(A, B);
    expect(d.adds).toBe(2);
    expect(d.dels).toBe(1);
    expect(d.hunks.length).toBe(1);
  });

  it('reports zero changes for identical input', () => {
    const d = diffLines(A, A);
    expect(d.adds).toBe(0);
    expect(d.dels).toBe(0);
    expect(d.hunks.length).toBe(0);
  });

  it('numbers context lines on both sides independently', () => {
    const d = diffLines(A, B);
    const found = d.ops.find(op => op.type === 'ctx' && op.text === '  "a": 1,');
    expect(found).toMatchObject({ aNum: 2, bNum: 2 });
  });
});
