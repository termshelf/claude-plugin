# TermShelf MCP server

A small Node.js MCP server that exposes the TermShelf external management API (`/api/v1/management/*`) as typed tools so Claude Code can drive brand-onboarding workflows end-to-end.

## Install

```sh
cd mcp-server
npm install
```

Two environment variables drive it:

- `TERMSHELF_TOKEN` (required) — a Sanctum bearer token issued from the customer-app **Settings → API Tokens** page. The server refuses to start without it.
- `TERMSHELF_BASE_URL` (optional) — defaults to `https://app.termshelf.de`. For local development against a Docker stack, set it to `http://app.termshelf.local:9191`.

Token scopes you'll usually want for the author skill:

- `content:read` — reads variables, snippets, locales
- `structure:read` — reads sites
- `structure:write` — creates brands, sites, domains, markets
- `overrides:write` — creates variable + snippet overrides

The token should NOT include `publish:trigger` for the author skill — publishing stays operator-driven.

## Run

```sh
TERMSHELF_TOKEN=<token> npm start
```

The plugin manifest at `.claude-plugin/plugin.json` registers this server under the name `termshelf-author`, so once the plugin is installed Claude Code spawns it automatically when the `termshelf-author` skill is invoked.

## Tools

### Reads

| Tool | What it does | Required ability |
|---|---|---|
| `whoami` | Confirm auth + return user / workspace / token metadata | `structure:read` |
| `list_sites` | List sites with filters (brand_id, status) + pagination | `structure:read` |
| `get_site` | Fetch a site by ID with embedded domains / markets / profiles | `structure:read` |
| `list_workspace_variables` | List variables with `is_locale_agnostic`, `published_value`, `overrides_count` | `content:read` |
| `list_workspace_snippets` | List snippets with `published_blocks`, `overrides_count` | `content:read` |
| `list_locales` | List every locale in active use in the workspace | `content:read` |

### Writes

All write tools accept an optional `idempotency_key` parameter that forwards to the `Idempotency-Key` HTTP header — same `(token, route, key)` tuple replays the original response within a 24h window.

| Tool | What it does | Required ability |
|---|---|---|
| `create_brand` | Create a brand in the active workspace | `structure:write` |
| `create_site` | Create a site linked to an existing brand | `structure:write` |
| `add_domain_to_site` | Attach a hostname (optionally primary) to a site | `structure:write` |
| `attach_market_to_site` | Attach an existing market to a site | `structure:write` |
| `create_variable_override` | Per-locale override for a workspace variable | `overrides:write` |
| `create_snippet_override` | Per-locale override for a workspace snippet | `overrides:write` |

### Closed-set error envelope

When the API rejects a request, the tool result is marked `isError: true` and the body carries one of the documented codes from ADR-058:

- `auth.bearer_required` — token missing or invalid
- `abilities.missing` — token lacks the required ability
- `rate_limit.exceeded` — too many requests for this token
- `token.workspace_missing` — token is not bound to a workspace
- `validation.failed` — request body failed validation (errors list per field)
- `resource.not_found` — entity does not exist in the active workspace
- `resource.conflict` — domain-level conflict (e.g. archived parent, slug collision)
- `override.ambiguous` — proposed override would create an unresolvable axis ambiguity
- `transport.unreachable` — synthesized client-side when the server can't reach `TERMSHELF_BASE_URL` at all (DNS, TLS, port closed); the bearer never leaves the MCP server on this path

The skill (`skills/termshelf-author/SKILL.md`) tells Claude how to branch on each.

## Security

- The token is read from the environment at startup and is **never** echoed back through any tool result, error message, or log line. If you see your token anywhere in a Claude transcript, that is a bug — rotate it immediately in Settings → API Tokens.
- The server only sends `Authorization` headers to `${TERMSHELF_BASE_URL}/api/v1/management/*`. It never reaches the public delivery API or any third-party host.
- All writes go through the management surface's audit log (`api_token_events`) on the server, so every action is attributable to the token even if it later gets revoked.
