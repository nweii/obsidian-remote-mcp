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

### ChatGPT

Add the server as a connector with your MCP URL and OAuth credentials. ChatGPT's legacy fixed callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is in the default allowlist. Newer connectors may present a per-app callback URL (`https://chatgpt.com/connector/oauth/…`) during setup — if OAuth fails with `redirect_uri not allowed`, add the URL ChatGPT shows you to **`MCP_ALLOWED_REDIRECT_URIS`**.

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
