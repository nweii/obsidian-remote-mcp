# Upstream

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit `13909c9e07590f5a85d93c62712259fe14a883f7` (MIT, see `LICENSE`), copied from `skills/install-anti-slop/assets/anti-slop/`. These files belong to this repository now; edit them to fit it.

## Local changes

- Only the rules enabled in `.oxlintrc.json` are kept. The Effect rules, `require-readable-spacing` (with its vendored ESLint Stylistic engine), and the rules that ban `unknown`, open dictionaries and `typeof` narrowing are left out: frontmatter is arbitrary YAML, so `unknown` with `typeof` checks is its honest type.
- `no-module-mocking` also rejects Bun's `mock.module` imported from `bun:test`.
