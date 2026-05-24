// ABOUTME: Pure line-based three-way (diff3) merge used to combine concurrent edits to a
// note. No I/O — given a common ancestor and two derived versions it returns either a
// clean merged text or the list of conflicting regions.

// Above this many lines on any side we skip the merge entirely. The LCS step below is
// O(n*m) in time and memory, so a pathologically large note could allocate a huge matrix.
// Callers treat "too big" the same as a cache miss: reject and ask the agent to re-read.
export const MERGE_MAX_LINES = 5000;

export interface ConflictRegion {
  base: string[];   // the common-ancestor lines for this region
  ours: string[];   // the current on-disk lines (the other session's change)
  theirs: string[]; // the incoming lines (this caller's change)
}

export type MergeResult =
  | { clean: true; text: string }
  | { clean: false; conflicts: ConflictRegion[] };

// Longest common subsequence of two line arrays, returned as the matched index pairs
// [indexInA, indexInB] in increasing order. Standard O(n*m) dynamic programming: dp[i][j]
// is the LCS length of a[i:] and b[j:]; we fill it bottom-up then walk top-down, taking a
// match when the lines are equal and otherwise stepping in the direction of the longer
// remaining subsequence. Note sizes are small, so the quadratic cost is fine in practice.
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// base line index -> matched variant line index, for every line the two share (via LCS).
// A base line present in this map was "kept" by the variant; one that's absent was changed
// or deleted on that side.
function matchMap(base: string[], variant: string[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const [bi, vi] of lcsPairs(base, variant)) {
    map.set(bi, vi);
  }
  return map;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Three-way merge of two independent edits to a common ancestor.
//
//   base   — the version both edits started from (the common ancestor)
//   ours   — the current on-disk content (changed by another session)
//   theirs — the incoming content (this caller's change)
//
// Algorithm (the classic diff3 region scan):
//   1. Split everything into lines. split('\n') is an exact inverse of join('\n'), so a
//      trailing newline survives as a final '' element and the merged text round-trips.
//   2. Find which base lines each side kept (matchMap, built from an LCS per side).
//   3. ANCHORS are base lines kept by *both* sides. Because each match map is monotonic in
//      base order, and an anchor's positions in ours/theirs are subsequences of monotonic
//      sequences, the anchors are simultaneously increasing in base, ours, and theirs.
//      They cleanly partition all three texts into aligned regions.
//   4. For each region between consecutive anchors, compare the three slices:
//        - ours unchanged from base  -> take theirs (only theirs edited here)
//        - theirs unchanged from base -> take ours  (only ours edited here)
//        - ours and theirs identical  -> take either (both made the same edit)
//        - otherwise                  -> a real conflict (both edited the same region
//                                        differently)
//
// Because anchors come from two independent LCS runs rather than one simultaneous
// alignment, this can occasionally flag a slightly wider conflict region than git would —
// but it is always *correct*: it never silently merges two overlapping edits, and
// non-overlapping edits (the common case) always merge cleanly.
export function threeWayMerge(baseText: string, oursText: string, theirsText: string): MergeResult {
  const base = baseText.split('\n');
  const ours = oursText.split('\n');
  const theirs = theirsText.split('\n');

  const oursMatch = matchMap(base, ours);
  const theirsMatch = matchMap(base, theirs);

  const anchors: number[] = [];
  for (let bi = 0; bi < base.length; bi++) {
    if (oursMatch.has(bi) && theirsMatch.has(bi)) {
      anchors.push(bi);
    }
  }

  const merged: string[] = [];
  const conflicts: ConflictRegion[] = [];

  // Position just past the previous anchor in each text; -1 means "before the first line".
  let prevBase = -1;
  let prevOurs = -1;
  let prevTheirs = -1;

  const resolveRegion = (
    baseLo: number, baseHi: number,
    oursLo: number, oursHi: number,
    theirsLo: number, theirsHi: number,
  ): void => {
    const b = base.slice(baseLo, baseHi);
    const o = ours.slice(oursLo, oursHi);
    const t = theirs.slice(theirsLo, theirsHi);

    if (arraysEqual(o, b)) {
      merged.push(...t);          // ours didn't touch this region
    } else if (arraysEqual(t, b)) {
      merged.push(...o);          // theirs didn't touch this region
    } else if (arraysEqual(o, t)) {
      merged.push(...o);          // both made the identical change
    } else {
      conflicts.push({ base: b, ours: o, theirs: t });
    }
  };

  for (const a of anchors) {
    const ao = oursMatch.get(a)!;
    const at = theirsMatch.get(a)!;
    // Region strictly between the previous anchor and this one.
    resolveRegion(prevBase + 1, a, prevOurs + 1, ao, prevTheirs + 1, at);
    merged.push(base[a]!); // the anchor line itself is common to all three
    prevBase = a;
    prevOurs = ao;
    prevTheirs = at;
  }
  // Trailing region after the last anchor (or the whole text if there were no anchors).
  resolveRegion(prevBase + 1, base.length, prevOurs + 1, ours.length, prevTheirs + 1, theirs.length);

  if (conflicts.length > 0) {
    return { clean: false, conflicts };
  }
  return { clean: true, text: merged.join('\n') };
}

// Compact, human-readable rendering of conflicts for the error returned to the agent.
export function summarizeConflicts(conflicts: ConflictRegion[]): string {
  return conflicts
    .map((c, i) => {
      const ours = c.ours.join('\n') || '(empty)';
      const theirs = c.theirs.join('\n') || '(empty)';
      return `Conflict ${i + 1}:\n  current note has:\n    ${ours.replace(/\n/g, '\n    ')}\n  your change has:\n    ${theirs.replace(/\n/g, '\n    ')}`;
    })
    .join('\n\n');
}
