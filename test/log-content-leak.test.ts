// ABOUTME: Tests that note body text never reaches the audit log — the logger records the first
// content block of an isError result and the message of any thrown error, so both must stay clean.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('the line number counts from the top of the note, not the frontmatter block', () => {
    // The duplicate key is the note's third line: the opening --- is line 1.
    try {
      parseFrontmatter('---\na: 1\na: 2\n---\nbody\n');
      throw new Error('expected a parse error');
    } catch (e) {
      expect((e as FrontmatterParseError).line).toBe(3);
      expect((e as Error).message).toContain('at line 3:');
    }
  });

  test('well-formed frontmatter still parses', () => {
    expect(parseFrontmatter('---\ntitle: Fine\n---\nbody\n')).toEqual({ title: 'Fine' });
  });

  test('a note with no frontmatter is still null', () => {
    expect(parseFrontmatter('just a body\n')).toBeNull();
  });

  test('unknown parser diagnostics fail closed rather than retaining source text', () => {
    const err = new FrontmatterParseError(`new parser diagnostic: ${SECRET_FM_VALUE}`, 3);
    expect(err.reason).toBe('could not be parsed');
    expect(err.message).toContain('line 3');
    expect(err.message).not.toContain(SECRET_FM_VALUE);
  });

  test('fixed syntax diagnostics remain useful', () => {
    const err = new FrontmatterParseError('duplicated mapping key', 2);
    expect(err.reason).toBe('duplicated mapping key');
    expect(err.message).toContain('duplicated mapping key');
  });
});

// Production logging is suppressed in the test process and its modules may already have cached
// a vault/log directory. Use a child process to exercise the actual registered handlers and disk
// logger with its own environment, without changing another test's logging or vault settings.
async function callWithAuditLog(note: string, tool: string, args: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'orm-log-content-'));
  try {
    const vaultPath = join(root, 'vault');
    const logDir = join(root, 'logs');
    await mkdir(vaultPath);
    await writeFile(join(vaultPath, 'note.md'), note);
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', `
        const handlers = new Map();
        const server = { registerTool(name, definition, handler) { handlers.set(name, handler); } };
        const { registerTools } = await import('./src/tools.ts');
        await registerTools(server);
        try {
          const result = await handlers.get(process.env.LOG_TEST_TOOL)(JSON.parse(process.env.LOG_TEST_ARGS));
          console.log(JSON.stringify({ result }));
        } catch (error) {
          console.log(JSON.stringify({ error: error.message, name: error.name }));
        }
      `],
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        VAULT_PATH: vaultPath,
        LOG_DIR: logDir,
        LOG_ENABLED: 'true',
        VAULT_MCP_TEST: '',
        VAULT_READ_ONLY: 'false',
        LOG_TEST_TOOL: tool,
        LOG_TEST_ARGS: JSON.stringify(args),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Audit logging child failed: ${stderr}`);
    const auditText = await readFile(join(logDir, 'tool-calls.jsonl'), 'utf8');
    const entries = auditText.trim().split('\n').map(line => JSON.parse(line));
    return {
      response: JSON.parse(stdout),
      auditText,
      entries,
      note: await readFile(join(vaultPath, 'note.md'), 'utf8'),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('registered tool errors never write source text to the audit log', () => {
  test.each([
    ['alias', '*DrReyesDiagnosis', 'unidentified alias'],
    ['tag', '!<therapist:DrReyes> value', 'unknown tag'],
    ['tag handle', '!DrReyesDiagnosis!value private', 'undeclared tag handle'],
    ['invalid tag', '!<DrReyesDiagnosis%XX> value', 'invalid tag name'],
    ['malformed tag', '!<DrReyesDiagnosis%FF> value', 'malformed tag name'],
  ])('%s names stay out of logged frontmatter errors', async (_, value, reason) => {
    const out = await callWithAuditLog(`---\nprivate: ${value}\n---\nbody\n`, 'vault_frontmatter', { path: 'note.md' });
    expect(out.response.result.isError).toBe(true);
    const message = out.response.result.content[0].text;
    expect(message).toContain(reason);
    expect(message).toMatch(/line \d+/);
    expect(message).toContain('Read the note and correct the frontmatter block');
    expect(JSON.stringify(out.response.result)).not.toContain('DrReyes');
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].tool).toBe('vault_frontmatter');
    expect(out.entries[0].ok).toBe(false);
    expect(out.entries[0].error).toBe(message);
    expect(out.auditText).not.toContain('DrReyes');
  });

  test('section previews reach the agent while the logged error stays clean', async () => {
    const note = `# Notes\n${SECRET_BODY}\n\n# Notes\nsecond private body\n`;
    const out = await callWithAuditLog(note, 'vault_edit_section', {
      path: 'note.md', heading: 'Notes', operation: 'replace', content: 'new',
    });
    expect(out.response.result.isError).toBe(true);
    expect(out.response.result.content[0].text).not.toContain(SECRET_BODY);
    expect(out.response.result.content[1].text).toContain(SECRET_BODY);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].error).toBe(out.response.result.content[0].text);
    expect(out.auditText).not.toContain(SECRET_BODY);
    expect(out.auditText).not.toContain('second private body');
    expect(out.note).toBe(note);
  });
});
