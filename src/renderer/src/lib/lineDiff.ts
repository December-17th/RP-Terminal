// Minimal line-level diff via longest-common-subsequence (Microscope-lite D5). The repo ships no diff
// library and adds no dependency; a two-run prompt comparison only needs unified add/remove lines.

export type LineDiffKind = 'context' | 'add' | 'remove'

export interface LineDiffRow {
  kind: LineDiffKind
  text: string
}

/**
 * Split a block into lines for diffing. An empty string is zero lines (not one empty line) so an
 * absent message contributes nothing; a trailing newline keeps its final empty segment so counts stay
 * honest.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n')
}

/**
 * Unified line diff of two texts: unchanged lines are `context`, lines only in `before` are `remove`,
 * lines only in `after` are `add`, emitted in reading order.
 */
export function diffLines(before: string, after: string): LineDiffRow[] {
  return diffLineArrays(splitLines(before), splitLines(after))
}

/** LCS-aligned unified diff over two arrays of lines. */
export function diffLineArrays(before: string[], after: string[]): LineDiffRow[] {
  const n = before.length
  const m = after.length
  // lcs[i][j] = length of the longest common subsequence of before[i..] and after[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const rows: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'remove', text: before[i] })
      i++
    } else {
      rows.push({ kind: 'add', text: after[j] })
      j++
    }
  }
  while (i < n) {
    rows.push({ kind: 'remove', text: before[i] })
    i++
  }
  while (j < m) {
    rows.push({ kind: 'add', text: after[j] })
    j++
  }
  return rows
}
