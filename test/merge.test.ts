// ABOUTME: Unit tests for the pure three-way (diff3) merge in src/merge.ts — clean merges of
// non-overlapping edits, one-sided changes, identical changes, and true conflicts.
import { describe, expect, test } from 'bun:test';
import { threeWayMerge } from '../src/merge.js';

// Convenience: assert a merge is clean and return its text; fails loudly otherwise so a
// surprise conflict doesn't show up as a confusing undefined.
function mergedText(base: string, ours: string, theirs: string): string {
  const result = threeWayMerge(base, ours, theirs);
  if (!result.clean) {
    throw new Error(`expected a clean merge but got ${result.conflicts.length} conflict(s)`);
  }
  return result.text;
}

describe('threeWayMerge', () => {
  test('no changes on either side returns the base unchanged', () => {
    const base = 'a\nb\nc\n';
    expect(mergedText(base, base, base)).toBe(base);
  });

  test('takes the one side that changed when the other is untouched', () => {
    const base = 'a\nb\nc\n';
    const ours = 'a\nB\nc\n'; // only ours changed line 2
    expect(mergedText(base, ours, base)).toBe(ours);
    expect(mergedText(base, base, ours)).toBe(ours); // symmetric
  });

  test('merges non-overlapping edits from both sides', () => {
    // ours edits the top, theirs edits the bottom — different regions, both should land.
    const base = 'header\n\nmiddle\n\nfooter\n';
    const ours = 'HEADER\n\nmiddle\n\nfooter\n';
    const theirs = 'header\n\nmiddle\n\nFOOTER\n';
    expect(mergedText(base, ours, theirs)).toBe('HEADER\n\nmiddle\n\nFOOTER\n');
  });

  test('keeps a single copy when both sides made the identical change', () => {
    const base = 'a\nb\nc\n';
    const same = 'a\nX\nc\n';
    expect(mergedText(base, same, same)).toBe(same);
  });

  test('reports a conflict when both sides change the same line differently', () => {
    const base = 'a\nb\nc\n';
    const ours = 'a\nOURS\nc\n';
    const theirs = 'a\nTHEIRS\nc\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.ours).toEqual(['OURS']);
      expect(result.conflicts[0]!.theirs).toEqual(['THEIRS']);
    }
  });

  test('weekly-note scenario: two sessions append updates under different headings', () => {
    // This is the real case that motivated the feature. Two sessions both read the same
    // weekly note, each adds a line under a different day, and write back. With three-way
    // merge both additions survive.
    const base = ['# Week 21', '', '## Mon', '- planned', '', '## Tue', '- planned', ''].join('\n');
    const sessionA = ['# Week 21', '', '## Mon', '- planned', '- shipped auth', '', '## Tue', '- planned', ''].join('\n');
    const sessionB = ['# Week 21', '', '## Mon', '- planned', '', '## Tue', '- planned', '- reviewed PRs', ''].join('\n');

    const merged = mergedText(base, sessionA, sessionB);
    expect(merged).toContain('- shipped auth');
    expect(merged).toContain('- reviewed PRs');
  });

  test('round-trips a trailing newline exactly', () => {
    const base = 'a\nb\n';
    const ours = 'a\nb\nc\n'; // appended a line, trailing newline preserved
    expect(mergedText(base, ours, base)).toBe('a\nb\nc\n');
  });

  test('merges an insertion on one side with an edit elsewhere on the other', () => {
    const base = 'intro\nbody\noutro\n';
    const ours = 'intro\nbody\nnew line\noutro\n'; // inserted before outro
    const theirs = 'INTRO\nbody\noutro\n';          // edited intro
    expect(mergedText(base, ours, theirs)).toBe('INTRO\nbody\nnew line\noutro\n');
  });
});
