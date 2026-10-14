# Client setup guides

Run the server with the [setup guide](docs/setup.md), then follow the instructions for your client.

## Claude.ai

Connect Claude to the server with a custom connector.

1. On the server, set `MCP_BASE_URL` to your public HTTPS address without `/mcp`, such as `https://mcp.example.com`. Restart the server or recreate the container after changing its settings.
2. In Claude, add a custom connector with `/mcp` included in the URL, such as `https://mcp.example.com/mcp`.
3. Under advanced settings, enter the server's `MCP_CLIENT_ID` as the OAuth client ID.
4. If you configured `MCP_CLIENT_SECRET` on the server, enter the same value as the OAuth client secret. Otherwise, leave it blank.

Claude's OAuth callback is allowed by default. If you replace the redirect allowlist, retain Claude's callback as described in [OAuth setup](docs/configuration.md#oauth-browser-sign-in).

## Cursor

In Cursor's `mcp.json`, use either `auth` for browser sign-in or an `Authorization` header for an API key. Do not set both on one entry.

### Browser sign-in

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://mcp.example.com/mcp",
      "auth": {
        "CLIENT_ID": "your-mcp-client-id",
        "CLIENT_SECRET": "your-mcp-client-secret (optional)"
      }
    }
  }
}
```

### API key

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
      }
    }
  }
}
```

Cursor's OAuth redirect URI (`cursor://anysphere.cursor-mcp/oauth/callback`) is in the default allowlist. If you set **`MCP_CLIENT_ALLOWED_REDIRECT_URIS`** yourself, include it so Cursor can still complete OAuth.

## ChatGPT and Codex

### ChatGPT web

Use OpenAI's [custom MCP server flow](https://developers.openai.com/api/docs/guides/custom-mcp-server). Set `MCP_BASE_URL` on the server to its public HTTPS address without `/mcp`.

1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), select **+ → Add custom MCP server**.
2. Enter a name and your server URL, including `/mcp` (for example, `https://mcp.example.com/mcp`).
3. Choose **OAuth** and configure one of the authentication options below.
4. Review the connection warning, select **I understand and want to continue**, then **Create as a plugin**. Complete browser authentication when prompted, using your approval password if configured.
5. Find the plugin in your personal plugins or the workspace where you created it, and install it. In a conversation, type `@` and select it.

ChatGPT supports this server's read and write tools without requiring tools named `search` or `fetch`. Write actions are subject to ChatGPT's confirmation settings. To pick up changed tools or server instructions, refresh its MCP connection in the plugin settings.

#### Dynamic client registration

Enable `MCP_DCR_ENABLED=true` on the server and keep `APPROVAL_PASSWORD` set. Select DCR in ChatGPT's OAuth settings. ChatGPT registers its own client and callback. To restrict accepted callbacks, set `MCP_DCR_ALLOWED_REDIRECT_URIS`.

#### User-defined OAuth client

Enter your `MCP_CLIENT_ID` and, if configured, `MCP_CLIENT_SECRET` in ChatGPT's OAuth settings.

The legacy callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is allowed by default. For a per-app callback (`https://chatgpt.com/connector/oauth/…`), add the exact URL ChatGPT shows to `MCP_CLIENT_ALLOWED_REDIRECT_URIS` if needed. This replaces the default list, so retain callbacks needed by other clients.

### ChatGPT desktop app and Codex

The desktop app does not accept a client ID and secret. Use OAuth self-registration or an API key.

#### OAuth self-registration

Enable `MCP_DCR_ENABLED=true` and keep `APPROVAL_PASSWORD` set on the server. Add the server over **Streamable HTTP** and complete browser sign-in. The client registers itself.

#### API key

1. Set `MCP_STATIC_BEARER_TOKEN` on the server to a long random value.
2. In the desktop app, open **Settings → MCP servers → Add server**.
3. Choose **Streamable HTTP** and enter `https://mcp.example.com/mcp`.
4. Add the header below, save the server, and restart the app.

```text
Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN
```

The **Bearer token env var** field expects an environment variable's name, not the token itself. Use a static `Authorization` header to enter the token directly.

The desktop app makes HTTP requests directly, so this path does not require a `CORS_ALLOWED_ORIGINS` change.

## Poke

### API key

Set `MCP_STATIC_BEARER_TOKEN` on the server. At [Poke's integration setup](https://poke.com/integrations/new), enter your MCP URL and paste the token into **API Key**.

### OAuth

Enable `MCP_DCR_ENABLED=true` for Poke's standard OAuth flow. See [OAuth setup](docs/configuration.md#oauth-browser-sign-in) for the approval-password requirement.

With DCR disabled, use [Kitchen](https://poke.com/kitchen). Create a template with your MCP URL, `MCP_CLIENT_ID`, and `MCP_CLIENT_SECRET`, then create a recipe that includes it. Leave **scopes** blank. The server ignores that field.

Poke's callback (`https://poke.com/api/v1/mcp/callback`) is allowed by default.

## Scripts and headless clients

For scripts and other HTTP clients, send the API key in an `Authorization` header. Add this entry to Antigravity's `mcp_config.json`.

```json
"obsidian-vault": {
  "serverUrl": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
  }
}
```

For a client that requires stdio, use an `mcp-remote` entry.

```json
"obsidian-vault": {
  "command": "bunx",
  "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp", "--transport", "http-only", "--header", "Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN"]
}
```
