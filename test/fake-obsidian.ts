// ABOUTME: Installs a fake `obsidian` CLI for tests, so CI needs no Obsidian. It reports a vault path,
// prints help, answers backlinks, and logs every non-probe argv to a file the test can inspect.
import { chmod, readFile, writeFile } from 'fs/promises';
import path from 'path';

export const FAKE_HELP = `Usage: obsidian [vault=<name>] <command> [options]

Commands:
  help                 Show help
  read                 Read file contents
    file=<name>          File name
    path=<path>          File path
  search               Search the vault
    query=<text>         (required)
  backlinks            List backlinks to a file
  create               Create a file
  command              Execute an Obsidian command
    id=<command-id>      (required)
  plugin:install       Install a community plugin
  plugins:restrict     Toggle restricted mode
  theme:install        Install a theme
  snippet:enable       Enable a CSS snippet
  restart              Restart the app
  reload               Reload the window

Developer:
  devtools             Open developer tools
  dev:console          Show console messages
  eval                 Execute JavaScript
`;

// Behaviour is steered by env vars read at each invocation:
//   FAKE_OBSIDIAN_VAULT     path printed for `vault info=path`
//   FAKE_OBSIDIAN_DOWN      when set, every call fails as if the app were unreachable
//   FAKE_OBSIDIAN_FAIL      when set, non-probe calls fail but the probe still succeeds
//   FAKE_OBSIDIAN_BACKLINKS stdout for `backlinks`
//   FAKE_OBSIDIAN_LOG       file each non-probe argv is appended to, one JSON array per line
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_OBSIDIAN_DOWN) {
  console.error('Unable to connect to Obsidian. Is the app running?');
  process.exit(1);
}
const [vaultArg, command, ...rest] = argv;
if (command === 'vault' && rest[0] === 'info=path') {
  console.log(env.FAKE_OBSIDIAN_VAULT ?? '');
  process.exit(0);
}
if (env.FAKE_OBSIDIAN_LOG) appendFileSync(env.FAKE_OBSIDIAN_LOG, JSON.stringify(argv) + '\\n');
if (env.FAKE_OBSIDIAN_FAIL) {
  console.error('Error: something went wrong');
  process.exit(2);
}
console.log('2026-10-12 09:00:00 Loading updated app package /Applications/Obsidian.app/obsidian-1.12.asar');
if (command === 'help' && rest.length === 0) {
  process.stdout.write(${JSON.stringify(FAKE_HELP)});
} else if (command === 'backlinks') {
  process.stdout.write(env.FAKE_OBSIDIAN_BACKLINKS ?? '[]');
} else {
  console.log(JSON.stringify({ vault: vaultArg, command, rest }));
}
`;

export async function installFakeObsidian(dir: string): Promise<string> {
  const bin = path.join(dir, 'obsidian');
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  return bin;
}

// Argv arrays the fake received outside the availability probe.
export async function fakeCalls(logFile: string): Promise<string[][]> {
  try {
    return (await readFile(logFile, 'utf-8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}
