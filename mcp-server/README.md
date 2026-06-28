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

- `content:read` — reads variables, snippets, locales, documents, document types
- `structure:read` — reads sites
- `structure:write` — creates brands, sites, domains, markets, site profiles
- `overrides:write` — creates variable + snippet overrides
- `content:write` — creates / edits workspace snippets + variables, document types, documents, sections, and blocks

The token should NOT include `publish:trigger` for the author skill — publishing stays operator-driven.

### Draft lifecycle (the MCP never publishes)

Every write through this server lands in a **draft** (working copy): document
sections/blocks, workspace snippets (`working_blocks`), and snippet/variable
overrides. A document block can reference a snippet that has **not been
published yet** — this is intentional so a document can be brought to a fully
*publishable state* in one authoring pass (e.g. extracting a shared plain block
into a snippet and adding a brand-scoped override). `get_document_preview`
resolves these drafts ("what publishing now would produce"), so per-brand /
per-locale results are verifiable before anything goes live.

What is **not** exposed here: publishing. Live **Public Delivery renders only
published versions**, so a draft snippet/override never leaks to the public.
Turning a reviewed draft into the live version is a deliberate human step in the
customer-app. Use `list_document_unpublished_refs` to see exactly what an
operator must publish. See the backend `docs/DECISIONS.md` entry
"MCP supports draft snippet lifecycle while Public Delivery remains
published-only".

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
| `list_markets`, `get_market` | List / fetch markets — the workspace-scoped variance axis (filter by `status`) | `structure:read` |
| `list_site_profiles`, `get_site_profile` | List / fetch site profiles — the second workspace-scoped variance axis (filter by `status`) | `structure:read` |
| `list_workspace_variables` | List variables with `is_locale_agnostic`, `published_value`, `overrides_count` | `content:read` |
| `list_workspace_snippets` | List snippets with `published_blocks`, `overrides_count` | `content:read` |
| `list_locales` | List every locale in active use in the workspace | `content:read` |
| `list_documents` | List documents (id, slug, title, `document_type.code`); filter by `document_type_code` | `content:read` |
| `get_document` | Fetch a single document by ID, including the full structured tree (sections + ordered blocks) | `content:read` |
| `list_document_types`, `get_document_type` | Discover the taxonomy a document attaches to (`privacy`, `imprint`, `terms`, …) | `content:read` |
| `list_document_sections`, `list_document_blocks` | Direct list endpoints for a document's structural children | `content:read` |
| `get_document_preview` | Render a document for a `(brand_id, locale, market_code, site_profile_code)` target. Returns the resolved HTML plus `unresolved_variables` / `unresolved_snippets`. Use this to verify overrides before publishing. | `content:read` |
| `list_document_unpublished_refs` | Pre-publish cascade discovery: which referenced snippets/variables/overrides have unpublished drafts for the given publication targets | `content:read` |

### Writes

All write tools accept an optional `idempotency_key` parameter that forwards to the `Idempotency-Key` HTTP header — same `(token, route, key)` tuple replays the original response within a 24h window.

| Tool | What it does | Required ability |
|---|---|---|
| `create_brand` | Create a brand in the active workspace | `structure:write` |
| `create_site` | Create a site linked to an existing brand | `structure:write` |
| `add_domain_to_site` | Attach a hostname (optionally primary) to a site | `structure:write` |
| `attach_market_to_site` | Attach an existing market to a site | `structure:write` |
| `create_market`, `update_market`, `activate_market`, `deactivate_market` | Market CRUD + lifecycle. `code` + `label` required on create; `code` is immutable afterwards (not editable via `update_market`); `country_code` optional ISO-3166 alpha-2 advisory metadata for Document Intelligence (NOT a locale). No delete — deactivate instead | `structure:write` |
| `create_site_profile`, `update_site_profile`, `activate_site_profile`, `deactivate_site_profile` | Site-profile CRUD + lifecycle. `code` + `label` required on create; `code` is immutable afterwards. No delete — deactivate instead | `structure:write` |
| `create_variable_override`, `update_variable_override`, `delete_variable_override` | Per-locale value overrides for a workspace variable | `overrides:write` |
| `create_snippet_override`, `update_snippet_override`, `archive_snippet_override`, `restore_snippet_override` | Per-locale rich-text overrides for a workspace snippet | `overrides:write` |
| `create_workspace_variable`, `update_workspace_variable`, `delete_workspace_variable` | Workspace-level variable CRUD | `content:write` |
| `create_workspace_snippet`, `update_workspace_snippet`, `archive_workspace_snippet`, `restore_workspace_snippet` | Workspace-level snippet CRUD | `content:write` |
| `create_document_type`, `update_document_type`, `activate_document_type`, `deactivate_document_type` | Document-type taxonomy CRUD | `content:write` |
| `create_document`, `update_document`, `archive_document`, `restore_document`, `delete_document` | Document row CRUD (the section/block tree is authored separately) | `content:write` |
| `add_document_locale`, `remove_document_locale` | Translation lifecycle. The default locale cannot be removed. | `content:write` |
| `upsert_document_section`, `delete_document_section`, `reorder_document_sections` | Document section CRUD (upsert by stable `key`) | `content:write` |
| `upsert_document_block`, `delete_document_block`, `reorder_document_blocks` | Document block CRUD — kinds `heading`, `paragraph`, `list`, `note`, `table`, `image`, `snippet_reference`; a `snippet_reference` may point to a **draft (unpublished) snippet** — it only needs to exist and not be archived (preview resolves the draft; live delivery needs an operator publish) | `content:write` |

> **Note — markets & site profiles.** The `*_market` / `*_site_profile` tools
> target `GET|POST|PATCH /markets`, `/markets/{id}/(de)activate`,
> `GET|POST|PATCH /site-profiles`, and `/site-profiles/{id}/(de)activate` on the
> management API. Hard deletion is intentionally not exposed — markets and site
> profiles are referenced by overrides, so they are deactivated, not deleted.
> The remaining site lifecycle gaps — `update_site`, `delete_site` /
> `archive_site`, `detach_market_from_site`, `remove_domain_from_site`, and
> `attach_site_profile` / `detach_site_profile` — are **not** exposed as tools:
> they currently exist only on the SPA `/api` surface and have no
> token-authenticated management route to call.

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
