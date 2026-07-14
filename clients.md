# Client setup guides

Per-client setup for connecting to an obsidian-remote-mcp server. See the [README](README.md) for running and configuring the server.

### Claude.ai

Available on paid plans, as a custom connector. Use your base URL with `/mcp` included. Under advanced settings, set OAuth client ID to your **`MCP_CLIENT_ID`**, and OAuth client secret to your **`MCP_CLIENT_SECRET`** if you've configured one for your server. On the server, set **`MCP_BASE_URL`** to the same origin as the connector URL, without `/mcp`.

Claude's OAuth callback is in the server's default redirect allowlist, so no further configuration is needed.

### Cursor

Cursor supports both auth styles in `mcp.json`. Pick one — do not set both `auth` and `headers` on the same entry.

OAuth:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://your-host/mcp",
      "auth": {
        "CLIENT_ID": "your-mcp-client-id",
        "CLIENT_SECRET": "your-mcp-client-secret (optional)"
      }
    }
  }
}
```

API key:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://your-host/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
      }
    }
  }
}
```

Cursor's OAuth redirect URI (`cursor://anysphere.cursor-mcp/oauth/callback`) is in the default allowlist. If you set **`MCP_CLIENT_ALLOWED_REDIRECT_URIS`** yourself, include it so Cursor can still complete OAuth.

### ChatGPT and Codex

ChatGPT has two MCP setup surfaces with different authentication paths. Pick the one for the app you are using.

#### ChatGPT web (developer mode)

Custom MCP connectors on the web app live behind developer mode (see OpenAI's [developer mode guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)):

1. At [chatgpt.com](https://chatgpt.com): **Settings → Plugins → Developer mode**, enable it.
2. Go to [chatgpt.com/plugins](https://chatgpt.com/plugins), click **+**, enter your `…/mcp` URL.
3. Pick **OAuth**, then open **Advanced OAuth settings**.

Two ways to authenticate:

- **Let it register itself** — enable dynamic client registration on the server with `MCP_DCR_ENABLED=true` (keep `APPROVAL_PASSWORD` set — it's the gate). ChatGPT's Registration URL populates automatically and you configure no callback.
- **Enter a client ID** — pick "User-Defined OAuth Client" and enter your `MCP_CLIENT_ID`. ChatGPT's legacy fixed callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is in the default allowlist, but newer connectors present a per-app callback (`https://chatgpt.com/connector/oauth/…`); if OAuth fails with `redirect_uri not allowed`, add the URL ChatGPT shows you to **`MCP_CLIENT_ALLOWED_REDIRECT_URIS`**.

Then create the connector, **Authenticate**, and complete the approval-password screen.

#### ChatGPT desktop app and Codex

The desktop app doesn't take a client ID/secret. Two paths work:

- **OAuth via self-registration** — with `MCP_DCR_ENABLED=true` on the server (see above), add the server over **Streamable HTTP** and complete the browser sign-in; it registers itself, no header needed.
- **Static bearer token** — set **`MCP_STATIC_BEARER_TOKEN`** on the server to a long random value, then in the desktop app open **Settings → MCP servers → Add server**. Choose **Streamable HTTP**, enter `https://your-host/mcp`, and add this header:

  ```text
  Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN
  ```

  The **Bearer token env var** field expects the *name* of an environment variable available to the desktop app, not the token itself. A static `Authorization` header is the straightforward option. Save the server and restart the app. `CORS_ALLOWED_ORIGINS` does not need changing for this path: the desktop app connects as an HTTP client, not browser JavaScript.

### Poke

[Poke](https://poke.com) supports both auth styles:

- **API key (simpler).** Set `MCP_STATIC_BEARER_TOKEN` on the server. At [poke.com/integrations/new](https://poke.com/integrations/new), enter your MCP URL and paste the same token into the **API Key** field. Poke sends it as `Authorization: Bearer …`, which is exactly what the server expects.
- **OAuth (via Kitchen).** Poke's standard OAuth path uses dynamic client registration. If you set `MCP_DCR_ENABLED=true` on the server (see the [README](README.md#oauth-browser-sign-in)), that path works directly. Otherwise use Poke's fixed-credentials flow: at [poke.com/kitchen](https://poke.com/kitchen), create a template with your MCP URL, **`MCP_CLIENT_ID`**, and **`MCP_CLIENT_SECRET`**, then a recipe that includes it. Leave **scopes** blank (the server ignores them). Poke's callback (`https://poke.com/api/v1/mcp/callback`) is in the default redirect allowlist.

### Scripts and headless clients

For anything that just sends HTTP headers, use the API key. Antigravity `mcp_config.json`:

```json
"obsidian-vault": {
  "serverUrl": "https://your-host/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
  }
}
```

Bridging over stdio with **`mcp-remote`**:

```json
"obsidian-vault": {
  "command": "bunx",
  "args": ["-y", "mcp-remote", "https://your-host/mcp", "--transport", "http-only", "--header", "Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN"]
}
```
