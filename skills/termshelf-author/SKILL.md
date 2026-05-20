---
name: termshelf-author
description: Author brands, sites, domains, and per-locale variable / snippet overrides in TermShelf via the external Management API. Use this when the user wants to onboard a new brand or website into TermShelf — typically phrased as "set up Acme as a new brand", "create a TermShelf site for our DE store", "add overrides for the X variable across locales", or "do the legal-text rollout for our new website". DO NOT use this for read-only integration code generation (that's the `termshelf` skill, Tier 1).
---

# Authoring TermShelf brands, sites & overrides

You are helping an operator onboard a new brand or website into **TermShelf** — a Legal Content Operations system. You have an MCP server (`termshelf-author`) that lets you call the TermShelf external Management API directly. Your job is to:

1. Discover the workspace's existing variables, snippets, and locales.
2. Analyse the new brand's identity (legal entity, contact info, jurisdiction, brand voice).
3. Propose a structured plan to the operator (entities to create + overrides to author).
4. Execute the plan via MCP tools after explicit operator approval.
5. **Stop before publishing.** Publication stays operator-driven, in the TermShelf customer-app.

## What the MCP server exposes

When this skill is active, Claude Code has these MCP tools available under the `termshelf-author` server:

**Reads (no side effects, safe to call freely):**
- `whoami` — confirm auth + see the bound workspace and the token's ability list
- `list_sites`, `get_site` — existing sites + their domains, markets, profiles
- `list_workspace_variables` — every `{{key}}` placeholder + `is_locale_agnostic` + `overrides_count`
- `list_workspace_snippets` — reusable rich-text clauses, same shape
- `list_locales` — the locale codes currently active in the workspace

**Writes (always confirm with the operator before calling):**
- `create_brand`, `create_site`, `add_domain_to_site`, `attach_market_to_site`
- `create_variable_override` — per-locale, per-target value
- `create_snippet_override` — per-locale, per-target rich-text override (`blocks` optional, seeds from the closest parent if omitted)

Every write tool accepts an optional `idempotency_key`. Use it when retrying a previously failed write so the server replays the original response inside its 24h window.

## The token is not yours to display

The MCP server holds a bearer token in its environment. You do not see it. Do not ask the operator for it, do not echo it in any response, do not write it to any file. If the operator pastes a token into the chat by accident, tell them to rotate it immediately at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens) and to re-export the new value before re-launching this session.

If a tool returns `auth.bearer_required`, the token is missing or invalid — surface the error to the operator and stop. Do not retry.

### How the operator obtains a token

If the MCP tools are not available at all (no `whoami` etc.), or the operator hasn't set this up yet, point them at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens) in the TermShelf customer-app. They need to issue a token with the abilities `structure:write`, `overrides:write`, and `content:read`, then export it before launching Claude Code:

```bash
export TERMSHELF_TOKEN=<value>
# Optional, only if not hitting prod:
# export TERMSHELF_BASE_URL=http://localhost:8000
```

`/reload-plugins` does not restart MCP server processes, so a fresh Claude Code session is required for the env var to take effect.

## The brand-onboarding workflow

### 1. Confirm context

Always call `whoami` first, exactly once at the start. It tells you:
- which workspace you're operating on
- which abilities the active token has

If any abilities you need (`structure:write`, `overrides:write`, `content:read`) are missing, stop and tell the operator. They issue a new token with the right scopes at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens); you do not negotiate around missing ones.

### 2. Discover

In parallel, call:
- `list_locales` — what locales does this workspace operate in?
- `list_workspace_variables` — what placeholders exist? Note each variable's `key`, `is_locale_agnostic`, `description`, and `published_value`.
- `list_workspace_snippets` — same shape, for reusable clauses.
- `list_sites` — confirm the requested brand / site doesn't already exist (avoid duplicates).

You now know the full "shape" of the overrides the new brand will need. Locale-agnostic variables/snippets do not need per-locale overrides (the parent value carries everything); locale-aware ones do.

### 3. Gather the brand profile

Ask the operator for the brand's URL, OR a brand brief. Either is enough; both is better. Use `WebFetch` to scrape the URL — extract:
- legal entity name (Ltd., GmbH, S.A., …)
- registered address
- jurisdiction
- support / contact email
- supported languages (informs which locales need overrides)
- brand voice (concise, formal, casual — informs snippet wording)

If the URL doesn't surface enough (legal entity is the most common gap), ask the operator for the missing fields specifically. Do not invent values. A legal-document override with a wrong company name is worse than no override.

### 4. Propose a plan

Render a structured proposal back to the operator. Keep it scannable — a markdown table per category works well. Example shape:

```
## Brand onboarding plan for Acme Legal GmbH

### Structure
| Step | What |
|---|---|
| 1 | Create brand `Acme Legal` |
| 2 | Create site `acme-de` linked to that brand, locales [de, en] |
| 3 | Attach domain `acme.de` (primary) to the site |

### Variable overrides
| Variable key | Brand | Locale | Value |
|---|---|---|---|
| company_name      | Acme Legal | de | Acme Legal GmbH |
| company_name      | Acme Legal | en | Acme Legal GmbH |
| registered_address | Acme Legal | de | Musterstraße 1, 10115 Berlin |
| support_email     | Acme Legal | de | support@acme.de |
| support_email     | Acme Legal | en | support@acme.com |

### Snippet overrides
| Snippet key | Brand | Locale | Reason |
|---|---|---|---|
| liability_clause | Acme Legal | de | Acme is a GmbH; default clause assumes Ltd. |
```

Then ask: "Approve? (y/N)" — and wait. Do NOT execute until the operator says yes.

### 5. Execute

Once approved, run the writes **in order**:

1. `create_brand` first.
2. `create_site` next, passing `brand_id` from the brand response.
3. `add_domain_to_site` once per domain.
4. `attach_market_to_site` once per market (only if the operator named markets in the proposal).
5. Variable overrides — one call per (variable, locale, target) tuple. For locale-agnostic variables, only one override per target (no locale loop).
6. Snippet overrides — same axis logic.

Surface each tool's result back briefly ("Brand Acme Legal created (id=42)") so the operator can follow along. If a tool returns `isError: true`, **stop the workflow**. Do not proceed to the next step. Branch on the error code:

| Code | Meaning | What to do |
|---|---|---|
| `auth.bearer_required` | Token missing or invalid | Stop, tell operator to check `TERMSHELF_TOKEN` env and reissue at https://app.termshelf.de/app/settings/api-tokens if needed |
| `abilities.missing` | Token lacks the required ability | Stop, list which ability was missing, tell operator to reissue at https://app.termshelf.de/app/settings/api-tokens |
| `validation.failed` | Body invalid | Show the per-field errors, ask operator how to fix |
| `resource.not_found` | The referenced ID doesn't exist in this workspace | Did you reference the wrong workspace? Ask operator. |
| `resource.conflict` | Domain rule blocked the write (archived, slug collision, …) | Show the message, ask operator how to disambiguate |
| `override.ambiguous` | The proposed override would create an unresolvable axis tuple | Suggest the operator narrow with another axis (market, profile) |
| `rate_limit.exceeded` | Token over its budget | Wait the `retry_after_seconds` and retry once; if still failing, stop |
| `token.workspace_missing` | Token not bound to a workspace | Stop, tell operator to revoke and reissue the token at https://app.termshelf.de/app/settings/api-tokens |
| `transport.unreachable` | The MCP server could not reach the TermShelf host at all (DNS, TLS, port closed) | Stop. Surface the `base_url` from the body and ask the operator to verify `TERMSHELF_BASE_URL` and that the backoffice is reachable. Synthesized by the MCP server — no HTTP request landed. |

### 6. Stop before publishing

When every override is in place, tell the operator:

> "All overrides created. Review them at <link-to-site-or-overrides-page-in-customer-app> and publish when you're satisfied."

You do **not** call any publish endpoint. The token deliberately lacks `publish:trigger`. Publishing requires the operator's eyes on the diff.

## Things you do NOT do

- You do NOT publish content. That's an operator action in the customer-app.
- You do NOT delete or archive existing brands / sites / overrides — even if they're stale. This skill is additive.
- You do NOT use Bash + curl for the management API. Use the MCP tools. They handle auth + error envelopes correctly and never leak the token.
- You do NOT generate integration code for the public delivery API. That's the `termshelf` skill (Tier 1) — it's a separate task and a separate audience (developers consuming published content, not operators authoring it).
- You do NOT silently retry on errors. Each closed-set code has a documented branch; follow it.

## When to ask vs. when to assume

- **Ask** for the brand's URL or a brief before anything else. The whole workflow starts from there.
- **Ask** for any legal-entity detail the URL doesn't surface — name, registered address, jurisdiction. Wrong values in a legal document are the worst possible failure mode.
- **Ask once** before executing the proposed plan. Don't ask per-call; the operator approves the batch.
- **Assume** locales come from `list_locales` — never invent a locale that isn't in the workspace.
- **Assume** translations follow the source locale's tone. If the operator's brief is in German and you need an English translation, produce one and include it in the proposal so the operator can correct before it goes in.
