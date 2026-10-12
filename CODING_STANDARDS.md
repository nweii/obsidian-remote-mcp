# Coding standards

Judgement rules for reviewing a diff. Mechanical rules live in the typecheck and the test suite (notably `test/vault-policy-matrix.test.ts`); these are the ones no check can enforce.

## Vault access

- An operation that acts on a folder checks every descendant against the policy, or refuses folders. Checking only the folder's own path lets a move or trash carry a note out from under a location-specific `.mcpignore` rule.
- A policy check runs before any other validation, so an error never reveals whether a protected file exists or what it contains.
- A security decision never rests on a cache keyed on stand-ins for content (timestamps, size, inode). Key it on the content itself, or on a version that changes whenever the content does.
- A path comparison that guards something (the policy file, the vault root) holds in both directions: the guarded path, its ancestors and its descendants.

## Errors and logs

- Error messages carry no note text, frontmatter values or absolute host paths; the audit log records the first content block of every error. Previews for the agent go in a second content block.
- An expected vault failure is thrown as one of the classes in the errors section of `src/vault.ts` and reaches the agent through `vaultErrorResult` in `src/tools.ts`. Code never branches on an error's message text; a raw filesystem error whose message would carry a host path is converted at the vault boundary.

## Documentation

- Behaviour worth explaining goes in the matching file under `docs/`, not in `AGENTS.md`, which holds only commands, layout, install policy and pointers.
