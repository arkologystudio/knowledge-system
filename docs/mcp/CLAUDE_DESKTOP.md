# Connect GBrain to Claude Desktop

**Important:** Claude Desktop does NOT connect to remote MCP servers via
`claude_desktop_config.json`. That file only works for local stdio servers.
Remote HTTP servers must be added through the GUI.

**Also important:** the connector dialog is **OAuth-only**. It has no bearer-token
field, so a token from `gbrain auth create` cannot be used here. See
[Authentication](#authentication) below.

## Setup

1. Open Claude Desktop
2. Go to **Settings > Connectors** (labelled **Integrations** in some builds)
3. Click **Add custom connector** (or **Add Integration**)
4. **Name** — anything; this is just the label in the connectors list
5. **URL** — the MCP endpoint, which must end in `/mcp`:
   ```
   https://your-brain.example.com/mcp
   ```
6. Expand **Advanced settings** and fill in **one** of the following:
   - **OAuth Client ID** (+ **Client Secret** for confidential clients) from
     `gbrain auth register-client`, or
   - **nothing at all** — if the server runs with `--enable-dcr`, the client
     registers itself via Dynamic Client Registration
7. **Add**

## Authentication

The dialog offers exactly three inputs: Name, URL, and — under **Advanced
settings** — OAuth Client ID and OAuth Client Secret. There is no field for a
bearer token.

So for this connector you need an OAuth client:

```bash
gbrain auth register-client claude-desktop \
  --scopes "read write" \
  --redirect-uri https://claude.ai/api/mcp/auth_callback \
  --token-endpoint-auth-method none
```

Passing `--redirect-uri` implies `--grant-types authorization_code`. Public
(PKCE) clients — `--token-endpoint-auth-method none` — get a `client_id` and no
secret; leave the **Client Secret** field empty for those.

Bearer tokens from `gbrain auth create` are still valid for everything that
speaks HTTP directly — `curl`, Claude Code via `gbrain connect`, and any client
that lets you set an `Authorization` header. They just cannot be entered in this
particular dialog.

### If the server sits behind a governance issuer

When `/authorize`, `/token`, and `/register` are served by a separate governance
service (see [KS-E governance retrieval](../deploy/KS-E-governance-retrieval.md)),
register the client **there**, not with `gbrain auth register-client` — the
gbrain-side client store is not consulted by that issuer, and a client registered
on the wrong side fails at `/authorize` with a generic
`"Invalid client or grant type"`. Newly registered clients may also need to be
bound to a principal before they can authorize. See the DCR notes in
[DEPLOY.md](DEPLOY.md#2-register-oauth-clients).

## Verify

Start a new conversation and try:

```
Search my brain for [any topic]
```

Claude Desktop will use your GBrain tools automatically.

To confirm what the connector is actually authenticated as, ask it to call
`whoami` — it returns the transport, client id, and granted scopes.

## Common Mistakes

**Using claude_desktop_config.json for remote servers** — this silently fails
with no error message. The JSON config only works for local stdio MCP servers.
Remote HTTP servers must be added via the GUI.

**Expecting a bearer-token field** — there isn't one. Minting a token with
`gbrain auth create` and then hunting for somewhere to paste it is a dead end;
register an OAuth client instead.

**Using the wrong URL** — make sure the URL ends with `/mcp` (not `/health`
or just the base domain). Note that `/health` may sit behind an access proxy
even when `/mcp` does not, so a redirect from `/health` is not evidence the
server is down.

**Writes fail with `repo_dirty`** — `commit_page` refuses to run against a
source checkout with uncommitted changes. Note that `put_page` writes into the
working tree *without* committing, so a single `put_page` call can leave the
repo dirty and block every subsequent `commit_page`. Check `git status` in the
source repo.
