# x-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for X's (Twitter's) **official** API v2 — no scraping, with automatic OAuth2 token refresh built in.

## Why this exists

The only real candidate MCP server found for X at the time this was built wrapped `agent-twitter-client`, a well-known library specifically designed to emulate a browser session so you don't need real API credentials at all. If you already have working OAuth tokens (as this project does), routing through a scraper instead is both unnecessary and strictly riskier — it trades a narrow, revocable API token for something closer to full session access, against a platform that actively fingerprints non-browser traffic patterns.

This wraps X's real API v2 directly.

## Setup

```bash
npm install
npm run build
```

Requires an X OAuth2 **user-context** access token with `tweet.write`/`users.read` scope, plus the refresh token, client ID, and client secret from the same OAuth2 app (app-only bearer tokens cannot post on a user's behalf — you need the 3-legged/PKCE flow).

### A real quirk: X access tokens expire in ~2 hours, and refresh tokens rotate

This is the reason the server's configuration looks slightly unusual compared to most MCP servers. X's OAuth2 user access tokens are short-lived, and every refresh call returns a **new** refresh token — the old one is immediately invalidated. A static env-var credential (the normal MCP pattern) can't survive that; it would work once and then be permanently broken.

So instead of taking the token directly, this server takes a **file path** and manages the credential file itself — reading it fresh before every call, refreshing proactively before expiry, and writing the new access/refresh token pair straight back to the same file. This means the file's `OAUTH2_ACCESS_TOKEN`/`OAUTH2_REFRESH_TOKEN` values will change on disk over time; that's expected, not a bug.

Create a credentials file:

```dotenv
OAUTH2_CLIENT_ID=your_client_id
OAUTH2_CLIENT_SECRET=your_client_secret
OAUTH2_ACCESS_TOKEN=initial_access_token
OAUTH2_REFRESH_TOKEN=initial_refresh_token
```

### Configuration

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/path/to/x-mcp/dist/index.js"],
      "env": {
        "X_CREDENTIALS_FILE": "/path/to/your/x-credentials.env"
      }
    }
  }
}
```

**Keep this file out of version control and readable only by the user running the server** (`chmod 600`).

## Available tools

| Tool | Description |
|---|---|
| `x_get_me` | Get the authenticated user's basic profile (safe, read-only) |
| `x_create_tweet` | Post a real, **immediately-live** tweet |

## ⚠️ No draft state

X's API has no unpublished/draft tweet state. Calling `x_create_tweet` posts immediately, with no undo. If you want a human-review step, it has to happen entirely on your side before calling this tool.

## Security model: `agent_id` capability gating

Built for a multi-agent fleet where several AI agents share one MCP process, and the underlying platform doesn't propagate per-agent caller identity down to MCP tool calls. `x_create_tweet` **requires an `agent_id` argument**, verified against an external authorization endpoint (`FLEET_BOARD_URL`, default `http://127.0.0.1:8420`) before it does anything.

**Honest limitation:** `agent_id` is self-reported by the caller, not cryptographically bound by the MCP protocol. This turns a *silent* wrong-agent action into a *loud, rejected, auditable* one — it does not stop a determined malicious actor from lying about its own identity.

Running standalone? Either stand up a minimal service at `FLEET_BOARD_URL` returning a JSON array of capability strings for `GET /agents/{id}/capabilities`, or remove the single `checkCapability` call in `src/index.ts`.

## Notes on safety

- Every request goes to `api.twitter.com` only — no telemetry, no third-party calls, no dynamic code execution, no browser automation.
- The credentials file is only ever read from and written to the exact path you provide — nothing is transmitted anywhere except the two X API domains used for auth and posting.

## License

MIT — see [LICENSE](LICENSE).
