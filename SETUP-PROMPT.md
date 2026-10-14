# Guided setup

Paste this prompt into a coding agent that can read files and run commands. It works from any directory.

```text
I want to set up obsidian-remote-mcp, a self-hosted server that gives my AI clients access to my Obsidian vault. Read its README at https://github.com/nweii/obsidian-remote-mcp and the linked guides before proposing a setup. Base your recommendations on this server's vault, hosting, HTTPS, and authentication requirements.

Ask how I want to use it, where I want to run it, and how comfortable I am with server setup. Explain unfamiliar concepts at my level. Help me decide the following.
- where I'll run it (NAS, VPS, an always-on PC/Mac)
- how my vault stays current on that machine, such as Obsidian Sync, git, or rsync
- how I'll reach it over HTTPS (Cloudflare Tunnel, Tailscale, a reverse proxy)
- which client I am connecting, such as Claude, ChatGPT, or Cursor
- how I want to guard sign-in (an approval password, a client secret, or a gateway)

Check current official documentation for Cloudflare, Tailscale, Docker, and the client's connector settings before using them. Use Context7, an available provider tool, or web search.

Recommend a run method that fits my setup, such as Docker or a Bun process managed by systemd or launchd. Produce the environment values and the required Compose file, service unit, plist, or command. Confirm the setup choices rather than assuming defaults.
```
