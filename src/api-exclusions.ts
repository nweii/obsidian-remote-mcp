// ABOUTME: Rules for which notes may be sent to an external model API: server-wide path exclusions from
// EXTERNAL_API_EXCLUDE_PATHS, plus per-call additions. They layer onto .mcpignore, which already hides
// notes from every tool; every feature that sends note text to a model provider checks these too.
import path from "node:path";
import { compileIgnoreRules } from "./ignore.js";

type RuleOrigin = "server config" | "this request";

export interface ExclusionRules {
  paths: { pattern: string; origin: RuleOrigin; matches: (relPath: string) => boolean }[];
}

const splitList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

const normalizePath = (p: string) => path.posix.normalize(p.trim().replace(/^\/+|\/+$/g, "") || ".").normalize("NFC");

// Config rules come from EXTERNAL_API_EXCLUDE_PATHS, plus the SKIM_EXCLUDE_PATHS alias when set (the lists
// combine, so neither can drop the other's rules). Request rules are added on top and can never remove a
// config rule.
export function exclusionRules(
  request: { exclude_paths?: string[] },
  env: NodeJS.ProcessEnv = process.env,
): ExclusionRules {
  const rule = (origin: RuleOrigin) => (p: string) => {
    const pattern = normalizePath(p);
    return { pattern, origin, matches: pathMatcher(pattern) };
  };
  return {
    paths: [
      ...[...splitList(env.EXTERNAL_API_EXCLUDE_PATHS), ...splitList(env.SKIM_EXCLUDE_PATHS)].map(rule("server config")),
      ...(request.exclude_paths ?? []).filter(p => p.trim() !== "").map(rule("this request")),
    ],
  };
}

// Tag exclusions are not supported. A deployment that still sets SKIM_EXCLUDE_TAGS expects those notes to
// be withheld, so features that send note text stay off until it is removed or replaced with path rules.
export function unsupportedExclusionSetting(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SKIM_EXCLUDE_TAGS?.trim()
    ? "SKIM_EXCLUDE_TAGS is set, but tag exclusions are not supported. Replace it with EXTERNAL_API_EXCLUDE_PATHS (or .mcpignore) rules, then remove it."
    : null;
}

// A path rule uses .mcpignore's syntax and matching: it covers the path and everything under it,
// ignoring case, and `*`, `?` and `**` wildcards are allowed. "." (or "/") covers the whole vault.
function pathMatcher(pattern: string): (relPath: string) => boolean {
  const rule = normalizePath(pattern);
  if (rule === ".") return () => true;
  const ignored = compileIgnoreRules(rule);
  return relPath => ignored(normalizePath(relPath));
}

export function pathMatches(relPath: string, pattern: string): boolean {
  return pathMatcher(pattern)(relPath);
}

export function pathExclusion(relPath: string, rules: ExclusionRules): string | null {
  const rule = rules.paths.find(r => r.matches(relPath));
  return rule ? `path ${rule.pattern} (${rule.origin})` : null;
}
