// ABOUTME: Tests that note body text never reaches the audit log — the logger records the first
// content block of an isError result and the message of any thrown error, so both must stay clean.
import { describe, expect, test } from 'bun:test';
import { AmbiguousHeadingError } from '../src/vault.js';
import { FrontmatterParseError, parseFrontmatter } from '../src/frontmatter.js';

// The two strings below stand in for private note content. Neither may appear in anything
// the audit logger writes to disk.
const SECRET_BODY = 'saw Dr Reyes about the diagnosis on Tuesday';
const SECRET_FM_VALUE = 'therapist: Dr Reyes';

describe('AmbiguousHeadingError keeps previews out of the logged message', () => {
  const err = new AmbiguousHeadingError({
    relativePath: 'Journal/2026-01.md',
    heading: 'Notes',
    matches: [
      { startIdx: 11, preview: `## Notes / ${SECRET_BODY}` },
      { startIdx: 40, preview: `## Notes / ${SECRET_BODY} again` },
    ],
  });

  test('the message does not contain body text', () => {
    expect(err.message).not.toContain(SECRET_BODY);
  });

  test('the message still names the note, heading and line numbers', () => {
    expect(err.message).toContain('Journal/2026-01.md');
    expect(err.message).toContain('Notes');
    expect(err.message).toContain('12');
    expect(err.message).toContain('41');
  });

  test('the message still points at the recovery path', () => {
    expect(err.message).toContain('vault_edit');
  });

  test('previews remain available to the agent via candidatesText()', () => {
    expect(err.candidatesText()).toContain(SECRET_BODY);
    expect(err.candidatesText()).toContain('line 12');
    expect(err.candidatesText()).toContain('line 41');
  });
});

describe('frontmatter parse errors keep the offending text out of the message', () => {
  // Unbalanced quote: js-yaml's own message quotes the source line back, which would put the
  // note's frontmatter into the log.
  const malformed = `---\n${SECRET_FM_VALUE}\n  bad: [unclosed\n---\nbody\n`;

  test('parsing throws FrontmatterParseError, not YAMLException', () => {
    expect(() => parseFrontmatter(malformed)).toThrow(FrontmatterParseError);
  });

  test('the message does not echo the frontmatter text', () => {
    try {
      parseFrontmatter(malformed);
      throw new Error('expected a parse error');
    } catch (e) {
      expect(e).toBeInstanceOf(FrontmatterParseError);
      expect((e as Error).message).not.toContain(SECRET_FM_VALUE);
      expect((e as Error).message).not.toContain('unclosed');
    }
  });

  test('the message still carries a reason and a line number', () => {
    try {
      parseFrontmatter(malformed);
      throw new Error('expected a parse error');
    } catch (e) {
      const err = e as FrontmatterParseError;
      expect(err.reason.length).toBeGreaterThan(0);
      expect(err.message).toMatch(/line \d+/);
    }
  });

  test('well-formed frontmatter still parses', () => {
    expect(parseFrontmatter('---\ntitle: Fine\n---\nbody\n')).toEqual({ title: 'Fine' });
  });

  test('a note with no frontmatter is still null', () => {
    expect(parseFrontmatter('just a body\n')).toBeNull();
  });
});
