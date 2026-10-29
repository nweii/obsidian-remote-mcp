// ABOUTME: Tests editNote and vault_edit's edits list — several find/replace pairs applied as one
// all-or-nothing write, regex and replace_all modes, the base_version guard, and the single-find form.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let vault: typeof import('../src/vault.js');
let createApp: () => { app: Express };
let vaultPath: string;

const BEARER = 'multi-edit-test-bearer';
const LIST = '# Shelf\n\n- apples are red\n- pears are green\n- plums are purple\n';

const read = (rel: string) => readFile(path.join(vaultPath, rel), 'utf-8');

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-multi-edit-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'multi-edit-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
  process.env.APPROVAL_OPEN = 'true';
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?multi-edit-test=${Date.now()}`);
  createApp = (await import('../src/app.js')).createApp;
});

beforeEach(async () => {
  await writeFile(path.join(vaultPath, 'list.md'), LIST, 'utf-8');
});

afterAll(async () => {
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('editNote', () => {
  test('applies several literal pairs in order as one write', async () => {
    const result = await vault.editNote('list.md', [
      { find: 'apples', replace: '**apples**' },
      { find: 'pears', replace: '**pears**' },
      { find: '**pears** are', replace: '**pears** stay' },
    ]);
    const text = await read('list.md');
    expect(text).toBe('# Shelf\n\n- **apples** are red\n- **pears** stay green\n- plums are purple\n');
    expect(result.version).toBe(vault.versionOf(text));
  });

  test('writes nothing when any pair has no match, and names that pair', async () => {
    const error = await vault
      .editNote('list.md', [
        { find: 'apples', replace: 'APPLES' },
        { find: 'cherries', replace: 'CHERRIES' },
      ])
      .catch(e => e);
    expect(error).toBeInstanceOf(vault.InvalidRequestError);
    expect(error.message).toContain('Edit 2 of 2:');
    expect(error.message).not.toContain('cherries');
    expect(error.message).toContain('no match');
    expect(await read('list.md')).toBe(LIST);
  });

  test('refuses an ambiguous literal match unless replace_all is set', async () => {
    const error = await vault.editNote('list.md', [{ find: ' are ', replace: ' look ' }]).catch(e => e);
    expect(error.message).toContain('matches 3 times');
    expect(await read('list.md')).toBe(LIST);

    await vault.editNote('list.md', [{ find: ' are ', replace: ' look ', replaceAll: true }]);
    expect(await read('list.md')).toBe('# Shelf\n\n- apples look red\n- pears look green\n- plums look purple\n');
  });

  test('literal replacements insert $ patterns verbatim', async () => {
    await vault.editNote('list.md', [{ find: 'red', replace: '$& and $1' }]);
    expect(await read('list.md')).toContain('apples are $& and $1\n');
  });

  test('regex with replace_all bolds the first word of every bullet', async () => {
    await vault.editNote('list.md', [{ find: '^- (\\w+)', replace: '- **$1**', regex: true, replaceAll: true }]);
    expect(await read('list.md')).toBe('# Shelf\n\n- **apples** are red\n- **pears** are green\n- **plums** are purple\n');
  });

  test('regex without replace_all must match exactly once', async () => {
    await vault.editNote('list.md', [{ find: 'p(\\w+)s are green', replace: 'P$1s are ripe', regex: true }]);
    expect(await read('list.md')).toContain('- Pears are ripe\n');
    const error = await vault.editNote('list.md', [{ find: '^- ', replace: '* ', regex: true }]).catch(e => e);
    expect(error.message).toContain('matches 3 times');
  });

  test('refuses patterns that match empty text, match too often, or do not compile', async () => {
    const empty = await vault.editNote('list.md', [{ find: 'x*', replace: '!', regex: true, replaceAll: true }]).catch(e => e);
    expect(empty.message).toContain('matches empty text');

    await writeFile(path.join(vaultPath, 'list.md'), 'a'.repeat(2000), 'utf-8');
    const many = await vault.editNote('list.md', [{ find: 'a', replace: 'b', replaceAll: true }]).catch(e => e);
    expect(many.message).toContain('more than 1000 times');
    expect(await read('list.md')).toBe('a'.repeat(2000));

    const invalid = await vault.editNote('list.md', [{ find: '(', replace: '', regex: true }]).catch(e => e);
    expect(invalid).toBeInstanceOf(vault.InvalidSearchPatternError);
  });

  test('base_version rejects the write when the note changed since it was read', async () => {
    const stale = vault.versionOf(LIST);
    await writeFile(path.join(vaultPath, 'list.md'), `${LIST}- figs are brown\n`, 'utf-8');
    const error = await vault.editNote('list.md', [{ find: 'apples', replace: 'APPLES' }], stale).catch(e => e);
    expect(error).toBeInstanceOf(vault.ConcurrentEditError);
    expect(await read('list.md')).toBe(`${LIST}- figs are brown\n`);

    const fresh = vault.versionOf(await read('list.md'));
    await vault.editNote('list.md', [{ find: 'apples', replace: 'APPLES' }], fresh);
    expect(await read('list.md')).toContain('APPLES');
  });

  test('a missing note is reported by its vault path', async () => {
    const error = await vault.editNote('nope.md', [{ find: 'a', replace: 'b' }]).catch(e => e);
    expect(error).toBeInstanceOf(vault.NotFoundError);
    expect(error.message).not.toContain(vaultPath);
  });
});

async function callEdit(args: Record<string, unknown>) {
  const { app } = createApp();
  const server = await new Promise<import('http').Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const addr = server.address() as import('net').AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_edit', arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text).result;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('vault_edit', () => {
  test('edits list applies all pairs and returns the new version', async () => {
    const result = await callEdit({
      path: 'list.md',
      operation: 'replace',
      edits: [
        { find: 'red', replace: 'crimson' },
        { find: '^- (\\w+)', replace: '- **$1**', regex: true, replace_all: true },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = await read('list.md');
    expect(text).toBe('# Shelf\n\n- **apples** are crimson\n- **pears** are green\n- **plums** are purple\n');
    expect(result.content[0].text).toBe(`Edited list.md (2 edits; version: ${vault.versionOf(text)})`);
  });

  test('a failing pair leaves the note untouched and returns an error', async () => {
    const result = await callEdit({
      path: 'list.md',
      operation: 'replace',
      edits: [{ find: 'red', replace: 'crimson' }, { find: 'blue', replace: 'navy' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Edit 2 of 2');
    expect(await read('list.md')).toBe(LIST);
  });

  test('a stale base_version is refused', async () => {
    const result = await callEdit({
      path: 'list.md',
      operation: 'replace',
      edits: [{ find: 'red', replace: 'crimson' }],
      base_version: 'not-the-version',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('changed since you last read it');
    expect(await read('list.md')).toBe(LIST);
  });

  test('the single find/content form replaces the first occurrence as before', async () => {
    const result = await callEdit({ path: 'list.md', operation: 'replace', find: ' are ', content: ' were ' });
    expect(result.isError).toBeFalsy();
    expect(await read('list.md')).toBe('# Shelf\n\n- apples were red\n- pears are green\n- plums are purple\n');
  });

  test('rejects edits mixed with find, and edits on append', async () => {
    const mixed = await callEdit({ path: 'list.md', operation: 'replace', find: 'red', content: 'x', edits: [{ find: 'a', replace: 'b' }] });
    expect(mixed.isError).toBe(true);
    const append = await callEdit({ path: 'list.md', operation: 'append', content: 'x', edits: [{ find: 'a', replace: 'b' }] });
    expect(append.isError).toBe(true);
    expect(await read('list.md')).toBe(LIST);
  });
});
