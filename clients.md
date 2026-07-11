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

Cursor's OAuth redirect URI (`cursor://anysphere.cursor-mcp/oauth/callback`) is in the default allowlist. If you set **`MCP_ALLOWED_REDIRECT_URIS`** yourself, include it so Cursor can still complete OAuth.

### ChatGPT and Codex

ChatGPT has two MCP setup surfaces with different authentication paths. Pick the one that matches the app you are using.

#### ChatGPT desktop app and Codex

Use the static bearer-token path. Set **`MCP_STATIC_BEARER_TOKEN`** on the server to a long random value, then in the ChatGPT desktop app open **Settings → MCP servers → Add server**. Choose **Streamable HTTP**, enter `https://your-host/mcp`, and add this header:

```text
Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN
```

The **Bearer token env var** field expects the *name* of an environment variable available to the desktop app, not the token itself. A static `Authorization` header is the straightforward option. Save the server and restart the app.

`CORS_ALLOWED_ORIGINS` does not need changing for this path: the desktop app connects as an HTTP client, not browser JavaScript.

#### Hosted ChatGPT connector

Hosted ChatGPT connectors use OAuth. The [Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth) expects a server to support Client ID Metadata Documents, dynamic client registration, or a predefined OAuth client. This server accepts one fixed **`MCP_CLIENT_ID`** and does not support the first two options, so treat hosted ChatGPT OAuth as unsupported unless you have verified a predefined-client configuration end to end. The legacy callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is in the default allowlist; newer connectors show their callback URL during setup, which must be added to **`MCP_ALLOWED_REDIRECT_URIS`**.

### Poke

[Poke](https://poke.com) supports both auth styles:

- **API key (simpler).** Set `MCP_STATIC_BEARER_TOKEN` on the server. At [poke.com/integrations/new](https://poke.com/integrations/new), enter your MCP URL and paste the same token into the **API Key** field. Poke sends it as `Authorization: Bearer …`, which is exactly what the server expects.
- **OAuth (via Kitchen).** Poke's standard OAuth path assumes dynamic client registration, which this server [does not support](README.md#oauth-browser-sign-in). Use Poke's fixed-credentials flow instead: at [poke.com/kitchen](https://poke.com/kitchen), create a template with your MCP URL, **`MCP_CLIENT_ID`**, and **`MCP_CLIENT_SECRET`**, then a recipe that includes it. Leave **scopes** blank (the server ignores them). Poke's callback (`https://poke.com/api/v1/mcp/callback`) is in the default redirect allowlist.

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
