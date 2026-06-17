# Guided setup

The simplest way to stand this up is to hand it to a coding agent. Paste the prompt below into one — Claude Code, Codex, Cursor, or anything that can read files, run commands, and search the web. Use a coding agent rather than a plain chat: it can do the setup *with* you — read the repo, write your config, run things, check the current provider docs — instead of only telling you what to do.

Drop the prompt wherever the setup is happening (your server, your infra folder, wherever the vault and deployment will live). You don't need to be inside this repo.

```
I want to set up obsidian-remote-mcp — a self-hosted server that gives my AI
clients access to my Obsidian vault. Before anything else, take your time with
its README at https://github.com/nweii/obsidian-remote-mcp and the docs it links
to (like clients.md). Don't skim — read it carefully and make sure you genuinely
understand how this particular server works: the pieces and how they fit (vault,
server, how it's exposed, how sign-in works) and how it's meant to run. Ground
your help in how it actually works, not general assumptions about MCP servers.

Then talk with me about how I want to use this — what I'm after, where it will
live, and how comfortable I am with this kind of setup — and let that steer the
plan instead of marching through a checklist. Pitch your explanations at my level
and fill in anything I'm unsure about. As we go, we'll need to land on:
- where I'll run it (NAS, VPS, an always-on PC/Mac)
- how my vault stays current on that machine (Obsidian Sync, git, rsync, …)
- how I'll reach it over HTTPS (Cloudflare Tunnel, Tailscale, a reverse proxy)
- which client I'm connecting (Claude.ai, ChatGPT, Cursor, …)
- how I want to guard sign-in (an approval password, a client secret, or a gateway)

The provider-specific pieces (Cloudflare, Tailscale, Docker, the client's
connector settings) change over time, so don't work from memory — pull the
current official docs first, using whatever you have: Context7, a provider's own
MCP/CLI/doc tool if I've set one up, or a web search otherwise.

Then recommend the simplest way to run it for my setup — Docker, a plain Bun
process under systemd/launchd, whatever fits — and produce the environment values
plus only what that run method needs (a compose file, a service unit, a plist, or
just a command). Don't assume defaults I haven't confirmed.
```
