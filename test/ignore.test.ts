// ABOUTME: .mcpignore wildcard semantics, compatibility, and descendant access boundaries.
import { describe, expect, test } from 'bun:test';
import { compileIgnoreRules } from '../src/ignore.js';

describe('.mcpignore rules', () => {
  test('preserves root-relative literal paths, comments, whitespace and trailing slashes', () => {
    const ignored = compileIgnoreRules(' # comment\r\n\n Private/ \r\nNotes/Secret.md\n');
    for (const name of ['Private', 'Private/Deep/Note.md', 'Notes/Secret.md']) {
      expect(ignored(name)).toBe(true);
    }
    for (const name of ['', 'Private-ish/Note.md', 'Other/Private/Note.md', 'Notes/Public.md']) {
      expect(ignored(name)).toBe(false);
    }
  });

  test('* and ? match within one path segment, and matched parents block descendants', () => {
    const ignored = compileIgnoreRules('Notes/draft?.md\nPrivate/*\n*.bak');
    for (const name of ['Notes/draft1.md', 'Private/Project/Deep/Note.md', 'backup.bak']) {
      expect(ignored(name)).toBe(true);
    }
    for (const name of ['Notes/draft12.md', 'Notes/Nested/draft1.md', 'Notes/backup.bak', 'Private']) {
      expect(ignored(name)).toBe(false);
    }
  });

  test('** matches zero or more directory levels', () => {
    const ignored = compileIgnoreRules('**/*.bak\nNotes/**/secret.md');
    for (const name of ['backup.bak', 'Notes/Deep/backup.bak', 'Notes/secret.md', 'Notes/A/B/secret.md']) {
      expect(ignored(name)).toBe(true);
    }
    expect(ignored('Other/secret.md')).toBe(false);
  });

  test('hidden entries can be blocked at the root or at every depth', () => {
    const rootOnly = compileIgnoreRules('.*/');
    expect(rootOnly('.env')).toBe(true);
    expect(rootOnly('.claude/CLAUDE.md')).toBe(true);
    expect(rootOnly('Notes/.claude/CLAUDE.md')).toBe(false);
    const everywhere = compileIgnoreRules('**/.*');
    for (const name of ['.env', '.claude/CLAUDE.md', 'Notes/.env', 'Notes/.claude/CLAUDE.md']) {
      expect(everywhere(name)).toBe(true);
    }
    expect(everywhere('Notes/v1.2.md')).toBe(false);
    expect(everywhere('')).toBe(false);
  });

  test('brackets, braces and exclamation marks remain literal, with no re-inclusion', () => {
    const ignored = compileIgnoreRules('Notes/[draft]\nNotes/{a,b}/*.md\n!important*.md\nPrivate\n!Private/Open.md');
    for (const name of ['Notes/[draft]/Open.md', 'Notes/{a,b}/Open.md', '!important-note.md', 'Private/Open.md']) {
      expect(ignored(name)).toBe(true);
    }
    for (const name of ['Notes/d/Open.md', 'Notes/a/Open.md', 'important-note.md', 'Public.md']) {
      expect(ignored(name)).toBe(false);
    }
  });

  test('existing literal wildcard filenames remain excluded', () => {
    expect(compileIgnoreRules('Notes/Question?.md')('Notes/Question?.md')).toBe(true);
  });

  test('glob exclusions normalize case and Unicode like literal exclusions', () => {
    const ignored = compileIgnoreRules('Privaté/**/SECRET?.md');
    expect(ignored('PRIVATE\u0301/Nested/secret1.md')).toBe(true);
    expect(ignored('privaté/secret2.md')).toBe(true);
    expect(ignored('privaté/open.md')).toBe(false);
  });
});
