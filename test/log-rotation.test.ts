// ABOUTME: Tests for startup log rotation — oversized .jsonl logs move to `.1`, replacing the previous
// generation; small logs, other files, and a disabled or absent cap are left alone.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { rotateLogs } from '../src/log.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'orm-log-rotation-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('rotates only .jsonl logs over the cap, replacing the previous generation', async () => {
  await writeFile(path.join(dir, 'tool-calls.jsonl'), 'x'.repeat(200));
  await writeFile(path.join(dir, 'tool-calls.jsonl.1'), 'old');
  await writeFile(path.join(dir, 'feedback.jsonl'), 'small');
  await writeFile(path.join(dir, 'notes.txt'), 'x'.repeat(200));
  expect(rotateLogs({ LOG_DIR: dir, LOG_MAX_BYTES: '100' })).toEqual(['tool-calls.jsonl']);
  expect((await readdir(dir)).sort()).toEqual(['feedback.jsonl', 'notes.txt', 'tool-calls.jsonl.1']);
  expect(await readFile(path.join(dir, 'tool-calls.jsonl.1'), 'utf-8')).toBe('x'.repeat(200));
});

test('LOG_MAX_BYTES=0 disables rotation, and a missing directory is fine', async () => {
  await writeFile(path.join(dir, 'tool-calls.jsonl'), 'x'.repeat(200));
  expect(rotateLogs({ LOG_DIR: dir, LOG_MAX_BYTES: '0' })).toEqual([]);
  expect(rotateLogs({ LOG_DIR: path.join(dir, 'missing') })).toEqual([]);
});

test('defaults to a 10 MB cap', async () => {
  await writeFile(path.join(dir, 'tool-calls.jsonl'), 'x'.repeat(1000));
  expect(rotateLogs({ LOG_DIR: dir })).toEqual([]);
});
