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

#### ChatGPT web

Use OpenAI's current [custom MCP server flow](https://developers.openai.com/api/docs/guides/custom-mcp-server). It does not require enabling developer mode. Adding and using custom plugins remains subject to workspace permissions and security restrictions.

1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), select **+ → Add custom MCP server**.
2. Enter a name and your server URL, including `/mcp` (for example, `https://your-host/mcp`).
3. Choose **OAuth** and configure one of the authentication options below.
4. Review the connection warning, select **I understand and want to continue**, then **Create as a plugin**. Complete browser authentication when prompted, using your approval password if configured.
5. Find the plugin in your personal plugins or the workspace where you created it, and install it. In a conversation, type `@` and select it.

Two ways to configure OAuth:

- **Dynamic client registration** — enable `MCP_DCR_ENABLED=true` on the server and keep `APPROVAL_PASSWORD` set. Select DCR in ChatGPT's OAuth settings; the server's discovery metadata advertises its registration endpoint. ChatGPT registers its own client and callback. You can restrict accepted callbacks with `MCP_DCR_ALLOWED_REDIRECT_URIS`.
- **User-defined OAuth client** — enter your `MCP_CLIENT_ID` and, if configured, `MCP_CLIENT_SECRET` in ChatGPT's OAuth settings. The legacy callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is in the server's default allowlist. For a per-app callback (`https://chatgpt.com/connector/oauth/…`), add the exact URL ChatGPT shows to `MCP_CLIENT_ALLOWED_REDIRECT_URIS` if it is not already allowed. Setting this variable replaces the default list, so retain callbacks needed by other clients.

Set `MCP_BASE_URL` to the public origin without `/mcp`. Use the DCR or user-defined client options above; do not select CIMD unless the server supports and advertises it.

ChatGPT supports this server's read and write tools without requiring tools named `search` or `fetch`. Write actions are subject to ChatGPT's confirmation settings. To pick up changed tools or server instructions, refresh its MCP connection in the plugin settings.

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
