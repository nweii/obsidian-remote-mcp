// ABOUTME: Tests for readAttachment — image happy path, size-cap rejection, .mcpignore blocking,
// stat-only metadata, and non-image base64.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

// A minimal but valid 1x1 PNG (correct signature + IHDR/IDAT/IEND chunks).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// VAULT_ROOT and IGNORE_PATTERNS in vault.ts are resolved at module-init time, so the
// vault dir and its .mcpignore must exist before the module is imported. We set VAULT_PATH
// first (so vault.js never reads the user's real Obsidian config) and use a unique query
// string to load a fresh module instance isolated from the other test files.
beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-attach-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';

  await mkdir(path.join(vaultPath, 'Attachments'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Attachments', 'pixel.png'), PNG_BYTES);
  await writeFile(path.join(vaultPath, 'Attachments', 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
  await writeFile(path.join(vaultPath, 'Private', 'secret.png'), PNG_BYTES);
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');

  vault = await import(`../src/vault.js?vault-attachment-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('readAttachment — images', () => {
  test('small png returns base64 data, image mime, and isImage', async () => {
    const att = await vault.readAttachment('Attachments/pixel.png');
    expect(att.mimeType).toBe('image/png');
    expect(att.isImage).toBe(true);
    expect(att.bytes).toBe(PNG_BYTES.length);
    expect(att.data).toBe(PNG_BYTES.toString('base64'));
  });
});

describe('readAttachment — non-image types', () => {
  test('pdf returns base64 with mime and size, not flagged as image', async () => {
    const att = await vault.readAttachment('Attachments/doc.pdf');
    expect(att.mimeType).toBe('application/pdf');
    expect(att.isImage).toBe(false);
    expect(att.data).toBeDefined();
  });
});

describe('readAttachment — size cap', () => {
  test('files over the cap are rejected with an error naming the actual size', async () => {
    const big = Buffer.alloc(PNG_BYTES.length + 10);
    PNG_BYTES.copy(big);
    await writeFile(path.join(vaultPath, 'Attachments', 'big.png'), big);
    process.env.VAULT_ATTACHMENT_MAX_BYTES = String(PNG_BYTES.length);
    try {
      await expect(vault.readAttachment('Attachments/big.png')).rejects.toThrow(
        new RegExp(`${big.length} bytes`),
      );
    } finally {
      delete process.env.VAULT_ATTACHMENT_MAX_BYTES;
      await rm(path.join(vaultPath, 'Attachments', 'big.png'), { force: true });
    }
  });

  test('the rejection is an AttachmentTooLargeError carrying the sizes', async () => {
    const big = Buffer.alloc(PNG_BYTES.length + 10);
    await writeFile(path.join(vaultPath, 'Attachments', 'big2.png'), big);
    process.env.VAULT_ATTACHMENT_MAX_BYTES = String(PNG_BYTES.length);
    try {
      await vault.readAttachment('Attachments/big2.png');
      throw new Error('expected AttachmentTooLargeError');
    } catch (e) {
      expect(e).toBeInstanceOf(vault.AttachmentTooLargeError);
      const err = e as InstanceType<typeof vault.AttachmentTooLargeError>;
      expect(err.bytes).toBe(big.length);
      expect(err.maxBytes).toBe(PNG_BYTES.length);
    } finally {
      delete process.env.VAULT_ATTACHMENT_MAX_BYTES;
      await rm(path.join(vaultPath, 'Attachments', 'big2.png'), { force: true });
    }
  });
});

describe('readAttachment — stat_only', () => {
  test('returns size and mime without the payload', async () => {
    const att = await vault.readAttachment('Attachments/pixel.png', true);
    expect(att.mimeType).toBe('image/png');
    expect(att.bytes).toBe(PNG_BYTES.length);
    expect(att.isImage).toBe(true);
    expect(att.data).toBeUndefined();
  });

  test('stat_only does not enforce the size cap', async () => {
    const big = Buffer.alloc(PNG_BYTES.length + 10);
    await writeFile(path.join(vaultPath, 'Attachments', 'big3.png'), big);
    process.env.VAULT_ATTACHMENT_MAX_BYTES = String(PNG_BYTES.length);
    try {
      const att = await vault.readAttachment('Attachments/big3.png', true);
      expect(att.bytes).toBe(big.length);
      expect(att.data).toBeUndefined();
    } finally {
      delete process.env.VAULT_ATTACHMENT_MAX_BYTES;
      await rm(path.join(vaultPath, 'Attachments', 'big3.png'), { force: true });
    }
  });
});

describe('readAttachment — sandboxing and .mcpignore', () => {
  test('path escaping the vault root is rejected', async () => {
    await expect(vault.readAttachment('../escape.png')).rejects.toThrow(/Path escapes vault root/);
  });

  test('a .mcpignore-blocked path is rejected', async () => {
    await expect(vault.readAttachment('Private/secret.png')).rejects.toThrow(/blocked by \.mcpignore/);
  });

  test('a directory path is rejected with EISDIR', async () => {
    try {
      await vault.readAttachment('Attachments');
      throw new Error('expected EISDIR');
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe('EISDIR');
    }
  });
});
