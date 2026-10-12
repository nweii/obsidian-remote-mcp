// ABOUTME: Compile .mcpignore path rules with *, ?, and ** wildcards, preserving literal exclusions.
import { Glob } from 'bun';

// Rules are rooted at the vault. A matching path also excludes every descendant, so direct
// reads and recursive walks enforce the same policy. This is an exclusion list, not gitignore:
// no negation, brace expansion, or character classes. Those characters remain literal.
// Conservative across filesystems: the same spelling/case rules apply on Linux and on
// case-insensitive macOS/SMB volumes. Never allow a case change to bypass an exclusion.
const key = (value: string) => value.normalize('NFC').toLowerCase();

// The rules a policy text holds, normalized. Leading `/` and `./` are accepted as root anchors, the
// way .gitignore writes them. Every rule is already rooted, so dropping them only prevents a rule
// that silently matches nothing.
export function parseIgnoreRules(text: string): string[] {
  return text.split('\n')
    .map(line => line.trim().replace(/^(?:\.?\/)+/, '').replace(/\/+$/, ''))
    .filter(line => line && !line.startsWith('#'))
    .map(key);
}

export function compileIgnoreRules(text: string): (relativePath: string) => boolean {
  const rules = parseIgnoreRules(text)
    .map(literal => ({
      literal,
      glob: /[*?]/.test(literal)
        ? new Glob(literal.replace(/[\\[\]{}!]/g, '\\$&'))
        : null,
    }));

  return relativePath => {
    if (!relativePath || rules.length === 0) return false;
    // Test ancestors too: Private/* must block Private/Project/Note.md once Project matches.
    let candidate = key(relativePath);
    while (candidate) {
      if (rules.some(rule => rule.literal === candidate || rule.glob?.match(candidate))) {
        return true;
      }
      const slash = candidate.lastIndexOf('/');
      if (slash < 0) break;
      candidate = candidate.slice(0, slash);
    }
    return false;
  };
}
