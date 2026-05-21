// ABOUTME: Tests for readNoteSection and editNoteSection — section bounds,
// splice operations (append/prepend/replace), and missing-heading errors.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function seed(rel: string, content: string): Promise<void> {
  await writeFile(path.join(vaultPath, rel), content, 'utf-8');
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-section-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-section-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

const SAMPLE = [
  '# Alpha',
  'alpha body',
  '',
  '## Alpha sub',
  'sub body',
  '',
  '# Bravo',
  'bravo body',
  '',
  '# Charlie',
  'charlie body',
  '',
].join('\n');

beforeEach(async () => {
  await seed('note.md', SAMPLE);
});

describe('readNoteSection', () => {
  test('returns heading through the next same-level heading, keeping nested subheadings', async () => {
    const section = await vault.readNoteSection('note.md', 'Alpha');
    expect(section).toBe(['# Alpha', 'alpha body', '', '## Alpha sub', 'sub body', ''].join('\n'));
  });

  test('reads the last section to EOF', async () => {
    const section = await vault.readNoteSection('note.md', 'Charlie');
    expect(section).toBe(['# Charlie', 'charlie body', ''].join('\n'));
  });

  test('matches heading case-insensitively', async () => {
    const section = await vault.readNoteSection('note.md', 'bravo');
    expect(section).toBe(['# Bravo', 'bravo body', ''].join('\n'));
  });

  test('throws when the heading is missing', async () => {
    await expect(vault.readNoteSection('note.md', 'Delta')).rejects.toThrow(/Heading "Delta" not found/);
  });
});

describe('editNoteSection', () => {
  test('replace swaps the section body, keeps the heading, and preserves the blank line before the next section', async () => {
    await vault.editNoteSection('note.md', 'Bravo', 'replace', 'new bravo body');
    const updated = await read('note.md');
    expect(updated).toBe([
      '# Alpha',
      'alpha body',
      '',
      '## Alpha sub',
      'sub body',
      '',
      '# Bravo',
      'new bravo body',
      '',
      '# Charlie',
      'charlie body',
      '',
    ].join('\n'));
  });

  test('prepend inserts right after the heading line, before existing body, and preserves the section boundary', async () => {
    await vault.editNoteSection('note.md', 'Bravo', 'prepend', 'lead-in line');
    const updated = await read('note.md');
    expect(updated).toBe([
      '# Alpha',
      'alpha body',
      '',
      '## Alpha sub',
      'sub body',
      '',
      '# Bravo',
      'lead-in line',
      'bravo body',
      '',
      '# Charlie',
      'charlie body',
      '',
    ].join('\n'));
  });

  test('append inserts at the end of the section body and preserves the blank line before the next heading', async () => {
    await vault.editNoteSection('note.md', 'Bravo', 'append', 'trailing line');
    const updated = await read('note.md');
    expect(updated).toBe([
      '# Alpha',
      'alpha body',
      '',
      '## Alpha sub',
      'sub body',
      '',
      '# Bravo',
      'bravo body',
      'trailing line',
      '',
      '# Charlie',
      'charlie body',
      '',
    ].join('\n'));
  });

  test('append on the last section writes through to EOF and preserves the trailing newline', async () => {
    await vault.editNoteSection('note.md', 'Charlie', 'append', 'tail');
    const updated = await read('note.md');
    expect(updated.endsWith('charlie body\ntail\n')).toBe(true);
  });

  test('caller controls internal spacing via newlines in content', async () => {
    // Caller wants a blank line between existing body and appended content —
    // they include a leading newline in `content`. The boundary blank line
    // before the next heading is still preserved by the function.
    await vault.editNoteSection('note.md', 'Bravo', 'append', '\nsecond paragraph');
    const updated = await read('note.md');
    expect(updated).toContain('bravo body\n\nsecond paragraph\n\n# Charlie');
  });

  test('editing one section leaves nested subheadings inside the prior section intact', async () => {
    await vault.editNoteSection('note.md', 'Bravo', 'replace', 'B');
    const updated = await read('note.md');
    // Alpha's nested "## Alpha sub" must still be present and unchanged.
    expect(updated).toContain('## Alpha sub\nsub body');
  });

  test('throws when the heading is missing and does not touch the file', async () => {
    await expect(vault.editNoteSection('note.md', 'Delta', 'append', 'x')).rejects.toThrow(/Heading "Delta" not found/);
    const updated = await read('note.md');
    expect(updated).toBe(SAMPLE);
  });

  test('respects VAULT_READ_ONLY by refusing to write', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    try {
      await expect(vault.editNoteSection('note.md', 'Bravo', 'append', 'x')).rejects.toThrow(/read-only/);
      const updated = await read('note.md');
      expect(updated).toBe(SAMPLE);
    } finally {
      delete process.env.VAULT_READ_ONLY;
    }
  });
});
