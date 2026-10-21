// ABOUTME: Rules for which notes may be sent to an external model API: server-wide tag and path
// exclusions from EXTERNAL_API_EXCLUDE_*, plus per-call additions. Every feature that sends note text to
// a model provider checks notes against these before sending. .mcpignore applies separately, to all access.
import path from "node:path";
import * as vault from "./vault.js";
import { compileIgnoreRules } from "./ignore.js";

type RuleOrigin = "server config" | "this request";

export interface ExclusionRules {
  tags: { pattern: string; origin: RuleOrigin }[];
  paths: { pattern: string; origin: RuleOrigin; matches: (relPath: string) => boolean }[];
}

const splitList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

const normalizeTag = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();
const normalizePath = (p: string) => path.posix.normalize(p.trim().replace(/^\/+|\/+$/g, "") || ".").normalize("NFC");

// Config rules come from EXTERNAL_API_EXCLUDE_TAGS / EXTERNAL_API_EXCLUDE_PATHS, plus the SKIM_EXCLUDE_*
// aliases when set (the lists combine, so neither can drop the other's rules). Request rules are added
// on top and can never remove a config rule.
export function exclusionRules(
  request: { exclude_tags?: string[]; exclude_paths?: string[] },
  env: NodeJS.ProcessEnv = process.env,
): ExclusionRules {
  const tag = (origin: RuleOrigin) => (t: string) => ({ pattern: normalizeTag(t), origin });
  const path = (origin: RuleOrigin) => (p: string) => {
    const pattern = normalizePath(p);
    return { pattern, origin, matches: pathMatcher(pattern) };
  };
  return {
    tags: [
      ...[...splitList(env.EXTERNAL_API_EXCLUDE_TAGS), ...splitList(env.SKIM_EXCLUDE_TAGS)].map(tag("server config")),
      ...(request.exclude_tags ?? []).map(tag("this request")),
    ].filter(r => r.pattern !== "" && r.pattern !== "*"),
    paths: [
      ...[...splitList(env.EXTERNAL_API_EXCLUDE_PATHS), ...splitList(env.SKIM_EXCLUDE_PATHS)].map(path("server config")),
      ...(request.exclude_paths ?? []).filter(p => p.trim() !== "").map(path("this request")),
    ],
  };
}

// `private` matches only #private; `work/*` matches #work and every tag nested under it.
export function tagMatches(tag: string, pattern: string): boolean {
  const t = normalizeTag(tag);
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return t === base || t.startsWith(base + "/");
  }
  return t === pattern;
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

// A note whose tags cannot be read can't be checked against the tag rules, so it is withheld.
export function contentExclusion(content: string, rules: ExclusionRules): string | null {
  let tags: string[];
  try {
    tags = vault.getNoteTags(content);
  } catch {
    return rules.tags.length > 0 ? "unreadable frontmatter, so its tags cannot be checked" : null;
  }
  return tagExclusion(tags, rules);
}

export function tagExclusion(tags: string[], rules: ExclusionRules): string | null {
  for (const rule of rules.tags) {
    const hit = tags.find(t => tagMatches(t, rule.pattern));
    if (hit) return `tag #${hit} (${rule.origin})`;
  }
  return null;
}
