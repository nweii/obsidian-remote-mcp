# Setup

[README](../README.md) · [Authentication and vault settings](configuration.md) · [Client setup](../clients.md)

## Run with Bun

Install [Bun](https://bun.sh), then run the server directly. No build step is required.

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=my-vault-mcp
export APPROVAL_PASSWORD=pick-a-password   # or APPROVAL_OPEN=true behind a gateway
export HOST=127.0.0.1
bun run src/server.ts
```

Choose a name for `MCP_CLIENT_ID` and enter the same ID in clients that ask for one. The server requires this variable even if you plan to use only an API key.

The server listens on port `3456` by default.

## Run with Docker

Save this as `docker-compose.yml` in the cloned repo directory. Replace the client ID, approval password, hostname, and host vault path with your own values.

```yaml
services:
  obsidian-remote-mcp:
    image: oven/bun:1              # pre-built Bun runtime — no local Bun install needed
    working_dir: /app
    restart: unless-stopped
    environment:
      MCP_CLIENT_ID: your-client-id
      APPROVAL_PASSWORD: choose-a-password
      # MCP_CLIENT_SECRET: your-client-secret   # optional for fixed-client OAuth
      MCP_BASE_URL: https://mcp.example.com
      VAULT_PATH: /vault                         # path inside the container (mapped by volumes below)
      PORT: 3456
      # TOKEN_STORE_PATH: /app/data/tokens.json  # optional separate token-store location
      # MCP_STATIC_BEARER_TOKEN: ${MCP_STATIC_BEARER_TOKEN}  # uncomment for ChatGPT desktop / Codex
    volumes:
      - ./:/app                                  # mounts the repo into the container
      - /path/to/your/vault:/vault               # left = path on your machine, right = path inside container
      # - ./data:/app/data                       # enable with the TOKEN_STORE_PATH override above
    command: ["bun", "run", "src/server.ts"]
    ports:
      - "127.0.0.1:3456:3456"                    # bind to loopback: reachable by a proxy on this host, not from the LAN
```

```bash
docker compose run --rm obsidian-remote-mcp bun install --frozen-lockfile
docker compose up -d      # start in background
docker compose logs -f    # watch output
```

## Upgrade

For a git checkout, pull the new version, reinstall from the lockfile, and restart the server.

```bash
git pull
bun install --frozen-lockfile
bun run src/server.ts
```

If you use URL clipping, run `bun run setup:clipper` again before restarting. With Docker, run the install through `docker compose run` as above, then `docker compose restart obsidian-remote-mcp`.

If you run the server from a folder you replace on upgrade, set `LOG_DIR` and `TOKEN_STORE_PATH` to paths outside it, or each upgrade loses its logs and every OAuth sign-in. See [keeping state across upgrades](server.md#keeping-state-across-upgrades).

## Install optional URL clipping

Install from the committed lockfile with `bun install --frozen-lockfile`. If you do not use URL clipping, omit its dependencies on a fresh installation.

```bash
bun install --frozen-lockfile --omit=optional
```

To enable URL clipping, install its dependencies and build the integration.

```bash
bun install --frozen-lockfile
bun run setup:clipper
```

With Docker, run these commands from the repo directory instead.

```bash
docker compose run --rm obsidian-remote-mcp bun install --frozen-lockfile
docker compose run --rm obsidian-remote-mcp bun run setup:clipper
docker compose restart obsidian-remote-mcp
```

For a direct Bun process, restart the server after building the clipper. Refresh your client's tool list after restarting.

Export your Obsidian Web Clipper settings and set `WEB_CLIPPER_SETTINGS_PATH` to that file's path as seen by the server. See [URL clipping](tools.md#url-clipping) for settings discovery, saving notes, and optional model processing.

Rebuild the clipper after dependency updates. Do not run separate installs inside `node_modules/web-clipper-headless` or `node_modules/obsidian-clipper`; those installs would bypass this repo's overrides and lockfile. `scripts/bootstrap-clipper.sh` calls the same setup command.

## Optional vault features

### Use the Obsidian desktop app's CLI tools

Enable the CLI tools to let agents work with Obsidian app features such as Bases, tasks, and Sync. Run the MCP server on the computer running Obsidian with the [Bun setup](#run-with-bun). Keep the computer awake and Obsidian open while clients need these tools.

Review the [CLI permissions and .mcpignore limitation](tools.md#obsidian-cli-tools) before enabling them. The CLI tools stay off while `.mcpignore` has rules unless you explicitly accept that limitation.

Install Obsidian desktop installer 1.12.7 or later. In Obsidian, enable **Settings → General → Command line interface** and follow the registration prompt. See the [Obsidian CLI installation guide](https://obsidian.md/help/cli) for installer requirements.

In the terminal where you started the MCP server, stop it with **Ctrl+C**. Restart it with the CLI tools enabled.

```bash
export OBSIDIAN_CLI_ENABLED=true
bun run src/server.ts
```

After [setting up HTTPS](#expose-it-over-https), follow [client setup](../clients.md). For OAuth, keep **Control the Obsidian app** selected when approving the connection. If the CLI reaches the same vault, the tool list includes `vault_cli_help` and `vault_cli`. Otherwise, the server log explains why.

### Sync a vault with Obsidian Headless

On a server or NAS without the desktop app, [Obsidian Headless](https://obsidian.md/help/headless) can keep a local vault folder synced through Obsidian Sync. Obsidian Headless is in open beta. It requires Node.js 22 or later and an active Obsidian Sync subscription. This MCP server reads and edits that folder; Headless handles syncing those changes to your other devices.

Back up your vault before setting up sync. Run these commands on the machine that will hold the vault.

```bash
npm install -g obsidian-headless
ob login
ob sync-list-remote
mkdir -p ~/vaults/personal
cd ~/vaults/personal
ob sync-setup --vault "Your Vault Name"
ob sync
ob sync --continuous
```

Replace `Your Vault Name` with a vault from `ob sync-list-remote`. Login and vault encryption credentials are prompted interactively. After the initial sync, keep `ob sync --continuous` running in a separate terminal or background service, alongside the MCP server.

Set `VAULT_PATH` to the absolute path of that same folder when starting the MCP server. With Docker, mount the host folder at `/vault` as shown above. Run Obsidian Headless and the MCP server as separate processes against that folder.

Use only one sync method per device. Running desktop Sync and Headless Sync together can cause data conflicts. See the [Headless Sync guide](https://obsidian.md/help/sync/headless) for configuration and sync options. Git, rsync, or another sync system can also maintain the local folder without Obsidian Headless.

## Expose it over HTTPS

Use a reverse proxy or tunneling service to make this server available at an HTTPS URL, such as `https://mcp.example.com`. The service handles the encrypted connection from your client, then forwards requests to the MCP server.

Choose one of the examples below. Each runs the HTTPS service on the same computer as the MCP server and forwards requests to `http://127.0.0.1:3456`. Here, `127.0.0.1` means this computer, and `3456` is the port the MCP server listens on.

Keep that local port accessible only from this computer.

- When running directly, set `HOST=127.0.0.1` and restart the server.
- In Docker, use `"127.0.0.1:3456:3456"` in `ports`, as in the Compose example. Leave `HOST` unset inside the container.

> A direct connection to port `3456` skips your HTTPS service and any login checks it provides. Restricting the port keeps remote clients on the protected URL.

### Cloudflare Tunnel

Cloudflare Tunnel gives the server a public HTTPS URL without opening incoming ports on your router. This setup requires a Cloudflare account, a domain on Cloudflare, and `cloudflared` running on the same computer as the MCP server.

For terminal or coding-agent setup, use the [Cloudflare CLI (`cf`)](https://developers.cloudflare.com/cf/agents/) to manage Cloudflare resources without the dashboard. After installing and signing in, `cf cli search "create a Cloudflare Tunnel"` finds the relevant commands.

Follow the [Cloudflare Tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/). Complete these steps in the Cloudflare dashboard.

1. Go to **Networking → Tunnels** and create a tunnel.
2. Select your computer's operating system under **Setup Environment**. Run the **Install and Run** commands shown there to connect `cloudflared`.
3. Add a **Published application** route with a hostname such as `mcp.example.com` and **Service URL** `http://127.0.0.1:3456`.

Keep `cloudflared` running to serve `https://mcp.example.com`. The tunnel makes the URL reachable; the MCP server's approval password and client credentials still control access.

#### Add Cloudflare Access login protection

Cloudflare Access, part of Zero Trust, can require a login before someone reaches the OAuth approval page. In the Cloudflare dashboard, go to **Zero Trust → Access controls → Applications** and create a self-hosted application for `mcp.example.com/authorize`. Configure an allow policy for the people who may approve clients. See the [Access application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) and [path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

Protect only `/authorize`. Leave `/.well-known/*`, `/register`, `/token`, and `/mcp` reachable so clients can discover the server, complete OAuth, and make authenticated requests.

Once Access requires a login on `/authorize`, you can use `APPROVAL_OPEN=true` instead of `APPROVAL_PASSWORD`. This makes Cloudflare's login the approval protection, so keep port `3456` private as described above.

### Tailscale

Install Tailscale and sign in to a Tailscale account on the computer running the MCP server. Choose the command for the clients you want to connect.

For a public HTTPS URL that cloud-hosted MCP connectors can reach, use [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).

```bash
tailscale funnel 3456
```

Funnel requires MagicDNS, HTTPS certificates, and permission to use Funnel in your Tailscale network. Follow the prompts or the linked setup guide to enable them. The terminal prints a public address such as `https://your-computer.your-tailnet.ts.net`. Keep the command running in that terminal.

For access only from devices in your private Tailscale network, use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

```bash
tailscale serve 3456
```

Serve requires HTTPS enabled for your Tailscale network. Cloud-hosted connectors generally cannot reach its private URL, even when the client app on your computer uses Tailscale. Use Serve when the MCP requests come from a device on your Tailscale network. Choose either Serve or Funnel for this HTTPS port; they cannot share it at the same time.

Keep `APPROVAL_PASSWORD` set with either option. Funnel provides a public URL without requiring visitors to sign in to Tailscale.

### Caddy

Use Caddy if you have a domain pointing to this computer and can allow incoming connections on ports `80` and `443`. Install Caddy on the same computer as the MCP server. See the [Caddy reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy) for installation and port permissions.

Save this as `Caddyfile`, replacing `mcp.example.com` with your domain.

```caddyfile
mcp.example.com {
	reverse_proxy 127.0.0.1:3456
}
```

From the folder containing `Caddyfile`, run Caddy.

```bash
caddy run
```

Caddy obtains and renews the HTTPS certificate and forwards requests to the MCP server. Keep Caddy running. Your HTTPS address is `https://mcp.example.com`; keep `APPROVAL_PASSWORD` set on the MCP server.

### Set the public URL

After your chosen service provides an HTTPS address, set `MCP_BASE_URL` to that address without `/mcp`. When running directly, stop the server with **Ctrl+C**, set the variable in that terminal, and start it again.

```bash
export MCP_BASE_URL=https://mcp.example.com
bun run src/server.ts
```

Use the terminal where you configured `VAULT_PATH`, `MCP_CLIENT_ID`, and `APPROVAL_PASSWORD`, so those settings remain available. With Docker, update `MCP_BASE_URL` in the Compose file and recreate the container with `docker compose up -d`.

Your client's MCP URL is that same HTTPS address with `/mcp` added, such as `https://mcp.example.com/mcp`.

## How it fits together

See the [architecture diagram in the README](../README.md#how-it-fits-together).
