import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let seedTestToken: () => string;
let vault: typeof import('../src/vault.js');
let vaultPath: string;

function toCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function issueAuthCode(base: string, codeChallenge: string): Promise<string> {
  const approveRes = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }),
  });

  expect(approveRes.status).toBe(302);
  const location = approveRes.headers.get('location');
  expect(location).toBeTruthy();
  const code = new URL(location!).searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not get listen address'));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close(err => (err ? rej(err) : res()));
          }),
      });
    });
    server.on('error', reject);
  });
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'obsidian-remote-mcp-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'test-client';
  process.env.MCP_CLIENT_SECRET = 'test-secret';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  // Defensive: another test file (e.g. vault-resolve.test.ts) may set a long
  // resolver TTL; clear so this file's resolver behavior is predictable.
  delete process.env.RESOLVE_INDEX_TTL_MS;

  const appMod = await import('../src/app.js');
  const authMod = await import('../src/auth.js');
  vault = await import('../src/vault.js');
  createApp = appMod.createApp;
  seedTestToken = authMod.seedTestToken;
});

afterAll(async () => {
  delete process.env.VAULT_MCP_TEST;
  delete process.env.VAULT_CONTEXT_PATH;
  delete process.env.VAULT_DISPLAY_NAME;
  delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('OAuth discovery', () => {
  test('protected resource metadata includes resource and authorization_servers', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe('https://example.test');
      expect(body.authorization_servers).toEqual(['https://example.test']);
    } finally {
      await close();
    }
  });

  test('authorization server metadata exposes token and authorize endpoints', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        token_endpoint_auth_methods_supported: string[];
      };
      expect(body.issuer).toBe('https://example.test');
      expect(body.authorization_endpoint).toBe('https://example.test/authorize');
      expect(body.token_endpoint).toBe('https://example.test/oauth/token');
      expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
    } finally {
      await close();
    }
  });
});

describe('OAuth token endpoint', () => {
  test('requires client_secret when MCP_CLIENT_SECRET is set', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-without-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_client');
    } finally {
      await close();
    }
  });

  test('accepts valid client_secret when provided', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-with-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { access_token?: string };
      expect(body.access_token).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('rejects invalid client_secret when provided', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-bad-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          client_secret: 'wrong-secret',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_client');
    } finally {
      await close();
    }
  });

  test('allows PKCE-only exchange when MCP_CLIENT_SECRET is unset', async () => {
    const prev = process.env.MCP_CLIENT_SECRET;
    delete process.env.MCP_CLIENT_SECRET;
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-without-configured-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { access_token?: string; token_type?: string };
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe('bearer');
    } finally {
      if (prev === undefined) delete process.env.MCP_CLIENT_SECRET;
      else process.env.MCP_CLIENT_SECRET = prev;
      await close();
    }
  });
});

describe('Vault-derived defaults', () => {
  test('uses the vault directory name as the default display name', () => {
    delete process.env.VAULT_DISPLAY_NAME;
    expect(vault.getVaultDisplayName()).toBe(path.basename(vaultPath));
  });

  test('uses VAULT_DISPLAY_NAME when provided', () => {
    process.env.VAULT_DISPLAY_NAME = 'Work notes';
    expect(vault.getVaultDisplayName()).toBe('Work notes');
    delete process.env.VAULT_DISPLAY_NAME;
  });

  test('falls back from AGENTS.md to CLAUDE.md for vault context', async () => {
    const agentsPath = path.join(vaultPath, 'AGENTS.md');
    const claudePath = path.join(vaultPath, 'CLAUDE.md');

    await writeFile(claudePath, '# Context\n', 'utf-8');
    expect(vault.getContextNotePath()).toBe('CLAUDE.md');

    await writeFile(agentsPath, '# Context\n', 'utf-8');
    expect(vault.getContextNotePath()).toBe('AGENTS.md');
  });

  test('uses VAULT_CONTEXT_PATH when provided', () => {
    process.env.VAULT_CONTEXT_PATH = 'Guides/assistant.md';
    expect(vault.getContextNotePath()).toBe('Guides/assistant.md');
    delete process.env.VAULT_CONTEXT_PATH;
  });

  test('uses DAILY_NOTE_PATH_TEMPLATE tokens', () => {
    process.env.DAILY_NOTE_PATH_TEMPLATE = 'Daily/{YYYY}/{MM}/{DD}-{dddd}.md';
    expect(vault.getPeriodicNotePath('daily', new Date(2026, 2, 26))).toBe('Daily/2026/03/26-Thursday.md');
    delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  });

  test('supports expanded daily note template tokens', () => {
    process.env.DAILY_NOTE_PATH_TEMPLATE = 'Journal/{YY}/{MMM}/{M}-{D}-{dd}.md';
    expect(vault.getPeriodicNotePath('daily', new Date(2026, 2, 26))).toBe('Journal/26/Mar/3-26-Th.md');
    delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  });

  test('daily cadence uses the built-in default template when unset', () => {
    expect(vault.getPeriodicNotePath('daily', new Date(2026, 2, 26))).toBe('Daily/2026-03-26.md');
  });

  test('non-daily cadences have no template until configured', () => {
    expect(vault.getPeriodicNotePath('weekly', new Date(2026, 2, 26))).toBeNull();
    expect(vault.getPeriodicNotePath('monthly', new Date(2026, 2, 26))).toBeNull();
    expect(vault.getPeriodicNotePath('quarterly', new Date(2026, 2, 26))).toBeNull();
    expect(vault.getPeriodicNotePath('yearly', new Date(2026, 2, 26))).toBeNull();
  });

  test('getPeriodicNoteTemplateEnvVar names each cadence env var', () => {
    expect(vault.getPeriodicNoteTemplateEnvVar('daily')).toBe('DAILY_NOTE_PATH_TEMPLATE');
    expect(vault.getPeriodicNoteTemplateEnvVar('weekly')).toBe('WEEKLY_NOTE_PATH_TEMPLATE');
    expect(vault.getPeriodicNoteTemplateEnvVar('monthly')).toBe('MONTHLY_NOTE_PATH_TEMPLATE');
    expect(vault.getPeriodicNoteTemplateEnvVar('quarterly')).toBe('QUARTERLY_NOTE_PATH_TEMPLATE');
    expect(vault.getPeriodicNoteTemplateEnvVar('yearly')).toBe('YEARLY_NOTE_PATH_TEMPLATE');
  });

  test('weekly cadence buckets any weekday into the same ISO week path', () => {
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = 'Weekly/{GGGG}-W{WW}.md';
    // 2026-03-23 (Mon) through 2026-03-29 (Sun) are all ISO week 13 of 2026.
    expect(vault.getPeriodicNotePath('weekly', new Date(2026, 2, 23))).toBe('Weekly/2026-W13.md');
    expect(vault.getPeriodicNotePath('weekly', new Date(2026, 2, 26))).toBe('Weekly/2026-W13.md');
    expect(vault.getPeriodicNotePath('weekly', new Date(2026, 2, 29))).toBe('Weekly/2026-W13.md');
    delete process.env.WEEKLY_NOTE_PATH_TEMPLATE;
  });

  test('weekly cadence uses ISO week-year at the New Year boundary', () => {
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = 'Weekly/{GGGG}-W{WW}.md';
    // 2025-12-29 (Mon) is in ISO week 1 of week-year 2026, not 2025.
    expect(vault.getPeriodicNotePath('weekly', new Date(2025, 11, 29))).toBe('Weekly/2026-W01.md');
    // Pairing the calendar-year token here would wrongly say 2025.
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = 'Weekly/{YYYY}-W{WW}.md';
    expect(vault.getPeriodicNotePath('weekly', new Date(2025, 11, 29))).toBe('Weekly/2025-W01.md');
    delete process.env.WEEKLY_NOTE_PATH_TEMPLATE;
  });

  test('monthly cadence buckets any day into the first of the month', () => {
    process.env.MONTHLY_NOTE_PATH_TEMPLATE = 'Monthly/{YYYY}-{MM}.md';
    expect(vault.getPeriodicNotePath('monthly', new Date(2026, 2, 1))).toBe('Monthly/2026-03.md');
    expect(vault.getPeriodicNotePath('monthly', new Date(2026, 2, 26))).toBe('Monthly/2026-03.md');
    delete process.env.MONTHLY_NOTE_PATH_TEMPLATE;
  });

  test('quarterly cadence buckets any date into its quarter number', () => {
    process.env.QUARTERLY_NOTE_PATH_TEMPLATE = 'Quarterly/{YYYY}-Q{Q}.md';
    expect(vault.getPeriodicNotePath('quarterly', new Date(2026, 0, 15))).toBe('Quarterly/2026-Q1.md');
    expect(vault.getPeriodicNotePath('quarterly', new Date(2026, 2, 26))).toBe('Quarterly/2026-Q1.md');
    expect(vault.getPeriodicNotePath('quarterly', new Date(2026, 3, 1))).toBe('Quarterly/2026-Q2.md');
    expect(vault.getPeriodicNotePath('quarterly', new Date(2026, 11, 31))).toBe('Quarterly/2026-Q4.md');
    delete process.env.QUARTERLY_NOTE_PATH_TEMPLATE;
  });

  test('yearly cadence buckets any date into its year', () => {
    process.env.YEARLY_NOTE_PATH_TEMPLATE = 'Yearly/{YYYY}.md';
    expect(vault.getPeriodicNotePath('yearly', new Date(2026, 0, 1))).toBe('Yearly/2026.md');
    expect(vault.getPeriodicNotePath('yearly', new Date(2026, 11, 31))).toBe('Yearly/2026.md');
    delete process.env.YEARLY_NOTE_PATH_TEMPLATE;
  });

  test('supports zero as no limit for title search', async () => {
    await writeFile(path.join(vaultPath, 'alpha.md'), '# alpha\n', 'utf-8');
    await writeFile(path.join(vaultPath, 'beta alpha.md'), '# beta alpha\n', 'utf-8');
    await writeFile(path.join(vaultPath, 'gamma alpha.md'), '# gamma alpha\n', 'utf-8');

    const results = await vault.findByTitle('alpha', false, 0);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test('reads and writes frontmatter properties', async () => {
    const notePath = path.join(vaultPath, 'frontmatter.md');
    await writeFile(notePath, '---\ntags:\n  - mcp\nstatus: draft\n---\n# Hello\n', 'utf-8');

    expect(await vault.getFrontmatterProperty('frontmatter.md', 'status')).toBe('draft');
    await vault.setFrontmatterProperty('frontmatter.md', 'status', 'published');
    await vault.setFrontmatterProperty('frontmatter.md', 'count', 3);

    const frontmatter = await vault.getFrontmatter('frontmatter.md');
    expect(frontmatter?.status).toBe('published');
    expect(frontmatter?.count).toBe(3);
  });

  test('parses common Obsidian frontmatter value types', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-types.md');
    await writeFile(
      notePath,
      [
        '---',
        'title: A New Hope',
        'link: "[[Episode IV]]"',
        'url: https://www.example.com',
        'cast:',
        '  - Mark Hamill',
        '  - Harrison Ford',
        '  - Carrie Fisher',
        'links:',
        '  - "[[Link]]"',
        '  - "[[Link2]]"',
        'year: 1977',
        'pie: 3.14',
        'favorite: true',
        'reply: false',
        'last:',
        'date: 2020-08-21',
        'time: 2020-08-21T10:30:00',
        'tags:',
        '  - journal',
        '  - personal',
        '  - draft',
        '---',
        '# Frontmatter types',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-types.md');

    expect(frontmatter?.title).toBe('A New Hope');
    expect(frontmatter?.link).toBe('[[Episode IV]]');
    expect(frontmatter?.url).toBe('https://www.example.com');
    expect(frontmatter?.cast).toEqual(['Mark Hamill', 'Harrison Ford', 'Carrie Fisher']);
    expect(frontmatter?.links).toEqual(['[[Link]]', '[[Link2]]']);
    expect(frontmatter?.year).toBe(1977);
    expect(frontmatter?.pie).toBe(3.14);
    expect(frontmatter?.favorite).toBe(true);
    expect(frontmatter?.reply).toBe(false);
    expect(frontmatter?.last).toBe(null);
    expect(frontmatter?.tags).toEqual(['journal', 'personal', 'draft']);
    expect(frontmatter?.date).toBeInstanceOf(Date);
    expect(frontmatter?.time).toBeInstanceOf(Date);
    expect((frontmatter?.date as Date).toISOString()).toBe('2020-08-21T00:00:00.000Z');
    expect((frontmatter?.time as Date).toISOString()).toBe('2020-08-21T10:30:00.000Z');
  });

  test('parses JSON-style frontmatter blocks', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-json.md');
    await writeFile(
      notePath,
      [
        '---',
        '{',
        '  "tags": ["journal"],',
        '  "publish": false',
        '}',
        '---',
        '# JSON frontmatter',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-json.md');
    expect(frontmatter).toEqual({
      tags: ['journal'],
      publish: false,
    });
  });

  test('getFolderTree returns indented dirs up to maxDepth, honours .mcpignore', async () => {
    const treeRoot = await mkdtemp(path.join(os.tmpdir(), 'obsidian-remote-mcp-tree-'));
    const prevVault = process.env.VAULT_PATH;
    process.env.VAULT_PATH = treeRoot;

    try {
      await mkdir(path.join(treeRoot, '02-Notes', 'Projects', 'Deep'), { recursive: true });
      await mkdir(path.join(treeRoot, '02-Notes', 'Reference'), { recursive: true });
      await mkdir(path.join(treeRoot, '03-Records', 'Journaling'), { recursive: true });
      await mkdir(path.join(treeRoot, '.obsidian'), { recursive: true });
      await writeFile(path.join(treeRoot, '.mcpignore'), '03-Records/Journaling\n', 'utf-8');

      // Re-import vault module so it re-resolves VAULT_PATH and reloads .mcpignore patterns.
      const treeVault: typeof import('../src/vault.js') = await import(`../src/vault.js?tree=${Date.now()}`);

      const depth1 = await treeVault.getFolderTree(1);
      expect(depth1).toEqual(['- 02-Notes/', '- 03-Records/']);

      const depth3 = await treeVault.getFolderTree(3);
      expect(depth3).toContain('- 02-Notes/');
      expect(depth3).toContain('  - Projects/');
      expect(depth3).toContain('    - Deep/');
      expect(depth3).toContain('  - Reference/');
      expect(depth3).toContain('- 03-Records/');
      // .mcpignore blocks 03-Records/Journaling
      expect(depth3.some(l => l.includes('Journaling'))).toBe(false);
      // dotfiles skipped
      expect(depth3.some(l => l.includes('.obsidian'))).toBe(false);

      expect(await treeVault.getFolderTree(0)).toEqual([]);
    } finally {
      if (prevVault === undefined) delete process.env.VAULT_PATH;
      else process.env.VAULT_PATH = prevVault;
      await rm(treeRoot, { recursive: true, force: true });
    }
  });

  test('setFrontmatterProperty writes an array as a YAML sequence, not a folded scalar', async () => {
    const notePath = path.join(vaultPath, 'fm-array.md');
    await writeFile(notePath, '---\nstatus: draft\n---\n# Array\n', 'utf-8');
    await vault.setFrontmatterProperty('fm-array.md', 'related', ['[[A]]', '[[B]]']);
    const raw = await readFile(notePath, 'utf-8');
    expect(raw).not.toContain('>-');
    expect(raw).toMatch(/related:\s*\n\s+-\s+["']?\[\[A\]\]/);
    expect(raw).toMatch(/-\s+["']?\[\[B\]\]/);
    // Round-trip: read it back and confirm it's an array.
    const frontmatter = await vault.getFrontmatter('fm-array.md');
    expect(Array.isArray(frontmatter?.related)).toBe(true);
    expect(frontmatter?.related).toEqual(['[[A]]', '[[B]]']);
  });

  test('setFrontmatterProperty coerces a JSON-stringified array (client that lost the array shape)', async () => {
    const notePath = path.join(vaultPath, 'fm-json-string.md');
    await writeFile(notePath, '---\nstatus: draft\n---\n# JSON string\n', 'utf-8');
    await vault.setFrontmatterProperty('fm-json-string.md', 'related', '["[[A]]","[[B]]"]');
    const frontmatter = await vault.getFrontmatter('fm-json-string.md');
    expect(frontmatter?.related).toEqual(['[[A]]', '[[B]]']);
  });

  test('setFrontmatterProperty leaves a string value that happens to contain brackets unchanged', async () => {
    const notePath = path.join(vaultPath, 'fm-bracket-string.md');
    await writeFile(notePath, '---\nstatus: draft\n---\n# Brackets\n', 'utf-8');
    // Looks bracket-like but isn't JSON — should be stored as a literal string.
    await vault.setFrontmatterProperty('fm-bracket-string.md', 'note', '[draft]');
    const frontmatter = await vault.getFrontmatter('fm-bracket-string.md');
    expect(frontmatter?.note).toBe('[draft]');
  });

  test('setFrontmatterProperty preserves untouched bare-date keys as date-only on round-trip', async () => {
    const notePath = path.join(vaultPath, 'fm-date.md');
    await writeFile(
      notePath,
      ['---', 'created: 2026-05-25', 'status: draft', '---', '# Dates', ''].join('\n'),
      'utf-8',
    );
    await vault.setFrontmatterProperty('fm-date.md', 'status', 'published');
    const raw = await readFile(notePath, 'utf-8');
    // The created date was never touched — it should still read as bare-date on disk,
    // not get normalized to a full ISO datetime.
    expect(raw).toContain('created: 2026-05-25');
    expect(raw).not.toContain('2026-05-25T');
  });

  test('setFrontmatterProperty appends when the key does not exist', async () => {
    const notePath = path.join(vaultPath, 'fm-append.md');
    await writeFile(notePath, '---\nstatus: draft\n---\n# Append\n', 'utf-8');
    await vault.setFrontmatterProperty('fm-append.md', 'tags', ['one', 'two']);
    const raw = await readFile(notePath, 'utf-8');
    expect(raw).toContain('status: draft');
    expect(raw).toMatch(/tags:\s*\n\s+-\s+one\s*\n\s+-\s+two/);
  });

  test('setFrontmatterProperty creates the frontmatter block when none exists', async () => {
    const notePath = path.join(vaultPath, 'fm-create.md');
    await writeFile(notePath, '# No frontmatter yet\n', 'utf-8');
    await vault.setFrontmatterProperty('fm-create.md', 'status', 'draft');
    const raw = await readFile(notePath, 'utf-8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('status: draft');
    expect(raw).toContain('# No frontmatter yet');
  });

  test('setFrontmatterProperty on JSON frontmatter saves as YAML (matches Obsidian behavior)', async () => {
    const notePath = path.join(vaultPath, 'fm-json-block.md');
    await writeFile(
      notePath,
      ['---', '{', '  "tags": ["journal"],', '  "publish": false', '}', '---', '# JSON', ''].join('\n'),
      'utf-8',
    );
    await vault.setFrontmatterProperty('fm-json-block.md', 'status', 'published');
    const frontmatter = await vault.getFrontmatter('fm-json-block.md');
    // All keys present; values intact; new key added.
    expect(frontmatter?.tags).toEqual(['journal']);
    expect(frontmatter?.publish).toBe(false);
    expect(frontmatter?.status).toBe('published');
    // Body intact.
    const raw = await readFile(notePath, 'utf-8');
    expect(raw).toContain('# JSON');
  });

  test('setFrontmatterProperty preserves an inline-array value on an untouched key', async () => {
    // Obsidian frontmatter accepts both `tags: [a, b, c]` (inline flow) and the
    // multi-line `tags:\n  - a` form. Setting an unrelated property should leave
    // the inline form byte-identical — the splice only touches the target key.
    const notePath = path.join(vaultPath, 'fm-inline.md');
    await writeFile(
      notePath,
      ['---', 'tags: [journal, draft]', 'status: draft', '---', '# Inline', ''].join('\n'),
      'utf-8',
    );
    await vault.setFrontmatterProperty('fm-inline.md', 'status', 'published');
    const raw = await readFile(notePath, 'utf-8');
    expect(raw).toContain('tags: [journal, draft]');
    expect(raw).toContain('status: published');
  });

  test('setFrontmatterProperty preserves blank lines and comments in the frontmatter', async () => {
    const notePath = path.join(vaultPath, 'fm-preserve.md');
    await writeFile(
      notePath,
      [
        '---',
        '# top-of-file comment',
        'created: 2026-05-25',
        '',
        'status: draft',
        '---',
        '# Preserve',
        '',
      ].join('\n'),
      'utf-8',
    );
    await vault.setFrontmatterProperty('fm-preserve.md', 'status', 'published');
    const raw = await readFile(notePath, 'utf-8');
    expect(raw).toContain('# top-of-file comment');
    expect(raw).toContain('created: 2026-05-25');
    expect(raw).toContain('status: published');
    // The blank line between created and status should still be there.
    expect(raw).toMatch(/created: 2026-05-25\n\nstatus: published/);
  });

  test('parses inline array frontmatter syntax', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-inline-arrays.md');
    await writeFile(
      notePath,
      [
        '---',
        'tags: [journal, personal, draft]',
        'links: ["[[Link One]]", "[[Link Two]]"]',
        '---',
        '# Inline arrays',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-inline-arrays.md');
    expect(frontmatter).toEqual({
      tags: ['journal', 'personal', 'draft'],
      links: ['[[Link One]]', '[[Link Two]]'],
    });
  });
});

describe('CORS', () => {
  test('allows all origins by default', async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`, {
        headers: { Origin: 'https://claude.ai' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await close();
    }
  });

  test('reflects configured allowed origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai,https://app.example.com';
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`, {
        headers: { Origin: 'https://claude.ai' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
      await close();
    }
  });

  test('rejects disallowed preflight origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai';
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
      await close();
    }
  });
});

describe('MCP /mcp', () => {
  test('GET without Authorization returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('GET with invalid Bearer returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer not-a-real-token',
        },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('GET with valid token returns 405 (no standalone SSE)', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const res = await fetch(`${base}/mcp`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')?.toUpperCase()).toContain('POST');
    } finally {
      await close();
    }
  });

  test('GET /mcp accepts MCP_STATIC_BEARER_TOKEN when set', async () => {
    const prev = process.env.MCP_STATIC_BEARER_TOKEN;
    process.env.MCP_STATIC_BEARER_TOKEN = 'static-bearer-test-secret';
    try {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/mcp`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: 'Bearer static-bearer-test-secret',
          },
        });
        expect(res.status).toBe(405);
      } finally {
        await close();
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_STATIC_BEARER_TOKEN;
      else process.env.MCP_STATIC_BEARER_TOKEN = prev;
    }
  });

  test('POST /mcp rejects wrong MCP_STATIC_BEARER_TOKEN', async () => {
    const prev = process.env.MCP_STATIC_BEARER_TOKEN;
    process.env.MCP_STATIC_BEARER_TOKEN = 'static-bearer-test-secret';
    try {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer definitely-wrong-secret',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'test', version: '1.0.0' },
            },
          }),
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe('invalid_token');
      } finally {
        await close();
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_STATIC_BEARER_TOKEN;
      else process.env.MCP_STATIC_BEARER_TOKEN = prev;
    }
  });

  test('POST without Authorization returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('POST initialize with valid token returns JSON-RPC result', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      expect(res.ok).toBe(true);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct.includes('application/json')).toBe(true);
      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: { protocolVersion: string; serverInfo: { name: string } };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result?.serverInfo?.name).toBe('obsidian-remote-mcp');
    } finally {
      await close();
    }
  });
});

describe('Title resolution via tool round-trips', () => {
  // Streamable-HTTP tool calls come back as SSE; parse the first data: line as JSON.
  async function callTool(
    base: string,
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 100000),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    // Response is either JSON or SSE-wrapped JSON. SSE looks like "event: message\ndata: {...}\n\n".
    const dataLine = text.split('\n').find(line => line.startsWith('data: '));
    const payload = dataLine ? dataLine.slice(6) : text;
    const body = JSON.parse(payload) as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result ?? {};
  }

  test('vault_read resolves a bare title and returns the note content', async () => {
    const titleFile = path.join(vaultPath, 'IntegrationFoo.md');
    await writeFile(titleFile, '# resolved\nhello\n', 'utf-8');
    vault.invalidateResolverCache();

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read', { path: 'IntegrationFoo' });
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toContain('hello');
      expect(result.isError).toBeFalsy();
    } finally {
      await close();
      await rm(titleFile, { force: true });
    }
  });

  test('vault_read emits a separate warning content block on title collision', async () => {
    const a = path.join(vaultPath, 'ResolverCollideOneA');
    const b = path.join(vaultPath, 'ResolverCollideOneB');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(path.join(a, 'Dupe.md'), '# from A\n', 'utf-8');
    await writeFile(path.join(b, 'Dupe.md'), '# from B\n', 'utf-8');
    vault.invalidateResolverCache();

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read', { path: 'Dupe' });
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.length).toBeGreaterThanOrEqual(2);
      expect(texts[0]).toContain('matched 2 notes');
      expect(texts[1]).toContain('from A'); // deterministic: A sorts before B
    } finally {
      await close();
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  test('vault_outline returns isError when the title cannot be resolved', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_outline', { path: 'NoSuchNoteIntegration' });
      expect(result.isError).toBe(true);
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toMatch(/Could not resolve/);
    } finally {
      await close();
    }
  });

  test('vault_edit_section appends to a section and writes the file', async () => {
    const file = path.join(vaultPath, 'SectionEditIntegration.md');
    await writeFile(file, '# A\nbody\n\n# B\nb body\n', 'utf-8');

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_edit_section', {
        path: 'SectionEditIntegration.md',
        heading: 'A',
        operation: 'append',
        content: 'appended',
      });
      expect(result.isError).toBeFalsy();
      const updated = await readFile(file, 'utf-8');
      expect(updated).toBe('# A\nbody\nappended\n\n# B\nb body\n');
    } finally {
      await close();
      await rm(file, { force: true });
    }
  });

  test('vault_edit_section returns isError with an outline hint when the heading is missing', async () => {
    const file = path.join(vaultPath, 'SectionEditMissingHeading.md');
    await writeFile(file, '# A\nbody\n', 'utf-8');

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_edit_section', {
        path: 'SectionEditMissingHeading.md',
        heading: 'NoSuchHeading',
        operation: 'append',
        content: 'x',
      });
      expect(result.isError).toBe(true);
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toMatch(/Heading "NoSuchHeading" not found/);
      expect(texts.join('\n')).toMatch(/vault_outline/);
      // File must remain untouched on error.
      const after = await readFile(file, 'utf-8');
      expect(after).toBe('# A\nbody\n');
    } finally {
      await close();
      await rm(file, { force: true });
    }
  });

  // Pull the version hash out of the trailing block vault_read appends.
  function versionFrom(texts: string[]): string {
    const match = texts.join('\n').match(/version: ([0-9a-f]{16})/);
    if (!match) throw new Error(`no version block found in: ${texts.join(' | ')}`);
    return match[1]!;
  }

  test('vault_read returns a version block alongside the note body', async () => {
    const file = path.join(vaultPath, 'VersionedRead.md');
    await writeFile(file, '# V\nbody\n', 'utf-8');

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read', { path: 'VersionedRead.md' });
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toContain('body');     // note body present
      expect(texts.join('\n')).toMatch(/version: [0-9a-f]{16}/); // version present
    } finally {
      await close();
      await rm(file, { force: true });
    }
  });

  test('vault_update rejects a stale base_version instead of overwriting a concurrent change', async () => {
    const file = path.join(vaultPath, 'RejectRoundTrip.md');
    await writeFile(file, '# R\noriginal\n', 'utf-8');

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const readResult = await callTool(base, token, 'vault_read', { path: 'RejectRoundTrip.md' });
      const version = versionFrom(readResult.content?.map(c => c.text) ?? []);

      // Another session changes the note out-of-band after the read.
      const concurrent = '# R\nother session edit\n';
      await writeFile(file, concurrent, 'utf-8');

      // Caller holding the stale version tries to overwrite — must be rejected.
      const result = await callTool(base, token, 'vault_update', {
        path: 'RejectRoundTrip.md',
        content: '# R\ncaller edit\n',
        base_version: version,
      });

      expect(result.isError).toBe(true);
      expect(result.content?.map(c => c.text).join('\n')).toMatch(/changed since you last read it|Re-read/);
      expect(await readFile(file, 'utf-8')).toBe(concurrent); // the other session's edit is preserved
    } finally {
      await close();
      await rm(file, { force: true });
    }
  });

  test('vault_update resolves a bare title to the same note vault_read versioned (no wrong-path write)', async () => {
    // Read by bare title resolves into a subfolder; updating by the same bare title must
    // target that resolved note (so the version check applies), not create a stray <root>/Titled.md.
    const dir = path.join(vaultPath, 'TitleResolveFolder');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'Titled.md');
    await writeFile(file, '# T\nshared\n', 'utf-8');
    vault.invalidateResolverCache();

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const readResult = await callTool(base, token, 'vault_read', { path: 'Titled' });
      const version = versionFrom(readResult.content?.map(c => c.text) ?? []);

      const result = await callTool(base, token, 'vault_update', {
        path: 'Titled', // bare title, same as the read
        content: '# T\nshared\nedited\n',
        base_version: version,
      });

      expect(result.isError).toBeFalsy();
      expect(await readFile(file, 'utf-8')).toContain('edited'); // wrote the resolved note
      // No stray note created at the vault root.
      await expect(readFile(path.join(vaultPath, 'Titled.md'), 'utf-8')).rejects.toThrow();
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('vault_move defaults to a dry run that moves nothing and rewrites nothing', async () => {
    const dir = path.join(vaultPath, 'MoveDryRun');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Target.md'), 'x\n', 'utf-8');
    await writeFile(path.join(dir, 'ref.md'), 'see [[Target]] here\n', 'utf-8');
    vault.invalidateResolverCache();

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_move', {
        source: 'MoveDryRun/Target.md',
        destination: 'MoveDryRun/Renamed.md',
      });
      expect(result.content?.map(c => c.text).join('\n')).toContain('Dry run');
      expect(await readFile(path.join(dir, 'Target.md'), 'utf-8')).toBe('x\n'); // not moved
      expect(await readFile(path.join(dir, 'ref.md'), 'utf-8')).toBe('see [[Target]] here\n'); // not rewritten
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('vault_move with dry_run false moves the file and rewrites a referring link', async () => {
    const dir = path.join(vaultPath, 'MoveWrite');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Subject.md'), 'x\n', 'utf-8');
    await writeFile(path.join(dir, 'ref.md'), 'see [[Subject]] here\n', 'utf-8');
    vault.invalidateResolverCache();

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_move', {
        source: 'MoveWrite/Subject.md',
        destination: 'MoveWrite/Renamed.md',
        dry_run: false,
      });
      expect(result.content?.map(c => c.text).join('\n')).toContain('MoveWrite/ref.md');
      expect(await readFile(path.join(dir, 'ref.md'), 'utf-8')).toBe('see [[Renamed]] here\n');
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('vault_read_attachment returns an image content block for a png', async () => {
    // A minimal but valid 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const dir = path.join(vaultPath, 'AttachRoundtrip');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'pixel.png');
    await writeFile(file, png);

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read_attachment', {
        path: 'AttachRoundtrip/pixel.png',
      });
      expect(result.isError).toBeFalsy();
      const block = result.content?.[0] as { type: string; data?: string; mimeType?: string };
      expect(block.type).toBe('image');
      expect(block.mimeType).toBe('image/png');
      expect(block.data).toBe(png.toString('base64'));
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('vault_read_attachment stat_only returns size and mime without the payload', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const dir = path.join(vaultPath, 'AttachStat');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pixel.png'), png);

    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read_attachment', {
        path: 'AttachStat/pixel.png',
        stat_only: true,
      });
      expect(result.isError).toBeFalsy();
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toContain('mime: image/png');
      expect(texts.join('\n')).toContain(`size: ${png.length} bytes`);
      // No image/base64 block when stat_only.
      expect(result.content?.some(c => (c as { type: string }).type === 'image')).toBeFalsy();
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('vault_read_attachment returns isError for a path outside the vault', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const result = await callTool(base, token, 'vault_read_attachment', { path: '../escape.png' });
      expect(result.isError).toBe(true);
      const texts = result.content?.map(c => c.text) ?? [];
      expect(texts.join('\n')).toMatch(/Path escapes vault root/);
    } finally {
      await close();
    }
  });
});

describe('Health /health', () => {
  async function withHealthToken(value: string | undefined, fn: () => Promise<void>) {
    const prev = process.env.HEALTH_TOKEN;
    if (value === undefined) delete process.env.HEALTH_TOKEN;
    else process.env.HEALTH_TOKEN = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.HEALTH_TOKEN;
      else process.env.HEALTH_TOKEN = prev;
    }
  }

  test('returns 404 when HEALTH_TOKEN is unset (default-closed)', async () => {
    await withHealthToken(undefined, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(404);
      } finally {
        await close();
      }
    });
  });

  test('returns 401 when the token is missing', async () => {
    await withHealthToken('health-test-secret', async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(401);
      } finally {
        await close();
      }
    });
  });

  test('returns 401 when the token is wrong', async () => {
    await withHealthToken('health-test-secret', async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/health`, {
          headers: { Authorization: 'Bearer not-the-health-secret' },
        });
        expect(res.status).toBe(401);
      } finally {
        await close();
      }
    });
  });

  test('returns 200 and { ok, version, uptime_seconds } with the correct token', async () => {
    await withHealthToken('health-test-secret', async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/health`, {
          headers: { Authorization: 'Bearer health-test-secret' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; version: string; uptime_seconds: number };
        expect(body.ok).toBe(true);
        expect(typeof body.version).toBe('string');
        expect(body.version.length).toBeGreaterThan(0);
        expect(typeof body.uptime_seconds).toBe('number');
        // Nothing else in the response: no vault name, paths, or counts.
        expect(Object.keys(body).sort()).toEqual(['ok', 'uptime_seconds', 'version']);
      } finally {
        await close();
      }
    });
  });

  test('returns 503 with ok: false when the vault root is unreadable', async () => {
    await withHealthToken('health-test-secret', async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      // Remove the vault root so the per-request stat fails, then restore it.
      await rm(vaultPath, { recursive: true, force: true });
      try {
        const res = await fetch(`${base}/health`, {
          headers: { Authorization: 'Bearer health-test-secret' },
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(false);
      } finally {
        await mkdir(vaultPath, { recursive: true });
        await close();
      }
    });
  });
});
