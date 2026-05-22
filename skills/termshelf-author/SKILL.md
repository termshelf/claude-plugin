---
name: termshelf-author
description: Author brands, sites, domains, document types, documents (with sections and blocks), and per-locale variable / snippet overrides in TermShelf via the external Management API. Use this when the user wants to onboard a new brand or website into TermShelf — typically phrased as "set up Acme as a new brand", "create a TermShelf site for our DE store", "add overrides for the X variable across locales", "do the legal-text rollout for our new website", or "draft a privacy policy document with these snippets". DO NOT use this for read-only integration code generation (that's the `termshelf` skill, Tier 1).
---

# Authoring TermShelf brands, sites, documents & overrides

You are helping an operator onboard a new brand or website into **TermShelf** — a Legal Content Operations system. You have an MCP server (`termshelf-author`) that lets you call the TermShelf external Management API directly. Your job is to:

1. Discover the workspace's existing variables, snippets, documents, document types, and locales.
2. Analyse the new brand's identity (legal entity, contact info, jurisdiction, brand voice) — and/or the requested document's structure when the operator is drafting a document.
3. Propose a structured plan to the operator (entities to create + overrides to author + documents to draft).
4. Execute the plan via MCP tools after explicit operator approval.
5. **Verify the result against the live preview**, iterating fixes until every (brand, locale) renders correctly.
6. **Stop before publishing.** Publication stays operator-driven, in the TermShelf customer-app.

## What the MCP server exposes

When this skill is active, Claude Code has these MCP tools available under the `termshelf-author` server:

**Reads (no side effects, safe to call freely):**
- `whoami` — confirm auth + see the bound workspace and the token's ability list
- `list_sites`, `get_site` — existing sites + their domains, markets, profiles
- `list_workspace_variables`, `get_workspace_variable` — every `{{key}}` placeholder + `is_locale_agnostic` + `overrides_count` + the live draft `value` and the last-published value + `has_unpublished_changes` (true iff the draft would actually persist a new version on publish)
- `list_workspace_snippets`, `get_workspace_snippet` — reusable rich-text clauses + `working_blocks` (draft) + `published_blocks` + `has_unpublished_changes`
- `list_locales` — the locale codes currently active in the workspace
- `list_documents`, `get_document` — documents in the workspace. `list_documents` returns the index (id, slug, title, document_type.code); filter by `document_type_code` to narrow. `get_document` returns the full structured tree (sections with their ordered blocks) for a single document.
- `list_document_types`, `get_document_type` — taxonomy entries a document attaches to (`privacy`, `imprint`, `terms`, …). Use these BEFORE `create_document` to pick the `document_type_id` / `document_type_code` to pass.
- `list_document_sections`, `list_document_blocks` — direct access to a document's structural children, ordered by position.
- `list_snippet_overrides`, `get_snippet_override` — existing snippet-override rows scoped to a snippet, with their working_blocks draft and `has_unpublished_changes`. Use this to fetch an override ID before updating or archiving it.
- `list_variable_overrides`, `get_variable_override` — same shape for variable overrides; also carries `has_unpublished_changes`.
- `get_document_preview` — render a document as fully-resolved HTML for a `(brand_id, locale, market_code, site_profile_code)` tuple. Resolves from the **draft working tree** (working_blocks of overrides + working_blocks of snippets + draft variable values), so changes made via the write tools below show up immediately — no publish step required. Use this to **verify** override resolution after authoring; surfaces `unresolved_variables`, `unresolved_snippets`, and the rendered text you can inspect for cross-locale leakage and placeholder stubs.
- `list_document_unpublished_refs` — pre-publish cascade discovery. Given a document and the publication targets the operator is about to publish to, returns the snippets, variables, snippet-overrides and variable-overrides whose working draft differs from the published version. Use this when the operator asks "what drafts are still pending for this document?" — surfaces the same checklist the customer-app's publish page renders. Read-only.

The `has_unpublished_changes` flag is true when the draft would actually persist as a new version on publish (i.e. the canonical hash of `working_blocks` differs from the latest published version's `content_hash`). An empty draft is never dirty, since the publisher refuses to publish it. Use this flag to answer "which authored items are still pending publish?" without diffing JSON blocks yourself.

**Override writes** (require the `overrides:write` ability — always confirm with the operator before calling):
- `create_variable_override`, `update_variable_override`, `delete_variable_override` — per-locale, per-target value. Delete is a hard-delete; the parent variable still needs at least one value somewhere (default OR override).
- `create_snippet_override`, `update_snippet_override`, `archive_snippet_override`, `restore_snippet_override` — per-locale, per-target rich-text override. Snippet overrides use soft archive (not hard delete); restore is rejected if it would create an ambiguity with another live override.

**Workspace-level writes** (require the `content:write` ability — confirm with the operator before calling):
- `create_workspace_snippet`, `update_workspace_snippet`, `archive_workspace_snippet`, `restore_workspace_snippet`
- `create_workspace_variable`, `update_workspace_variable`, `delete_workspace_variable`
- `create_document_type`, `update_document_type`, `activate_document_type`, `deactivate_document_type` — the taxonomy a document attaches to. The `code` is immutable once persisted.
- `create_document`, `update_document`, `archive_document`, `restore_document`, `delete_document` — the document row itself. `create_document` only stages the document; sections and blocks are authored separately. `delete_document` is rejected when publications / active reviews / pending patches still reference the document — archive instead in that case.
- `add_document_locale`, `remove_document_locale` — translation lifecycle. The default locale cannot be removed.
- `upsert_document_section`, `delete_document_section`, `reorder_document_sections` — the structural skeleton of a document. Sections are upserted by stable `key`; the `key` is immutable.
- `upsert_document_block`, `delete_document_block`, `reorder_document_blocks` — typed content units inside a section (`heading`, `paragraph`, `list`, `note`, `table`, `image`, `snippet_reference`). Variable references like `{{key}}` inside text are validated against the workspace's variables; `snippet_reference` payloads must point to a **published** snippet.

Every write tool accepts an optional `idempotency_key`. Use it when retrying a previously failed write so the server replays the original response inside its 24h window.

## The token is not yours to display

The MCP server holds a bearer token in its environment. You do not see it. Do not ask the operator for it, do not echo it in any response, do not write it to any file. If the operator pastes a token into the chat by accident, tell them to rotate it immediately at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens) and to re-export the new value before re-launching this session.

If a tool returns `auth.bearer_required`, the token is missing or invalid — surface the error to the operator and stop. Do not retry.

### How the operator obtains a token

If the MCP tools are not available at all (no `whoami` etc.), or the operator hasn't set this up yet, point them at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens) in the TermShelf customer-app. They need to issue a token with the abilities `structure:write`, `overrides:write`, `content:read`, and (for authoring workspace-level snippets/variables) `content:write`, then export it before launching Claude Code:

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

If any abilities you need are missing, stop and tell the operator. Required abilities by task: `content:read` for any discovery; `structure:write` for brand/site/domain/market creation; `overrides:write` for override CRUD; `content:write` for authoring workspace-level snippets/variables AND for creating/editing documents, document types, sections, and blocks (every endpoint under the document-drafting workflow). They issue a new token with the right scopes at [Settings → API Tokens](https://app.termshelf.de/app/settings/api-tokens); you do not negotiate around missing ones.

### 2. Discover

In parallel, call:
- `list_locales` — what locales does this workspace operate in?
- `list_workspace_variables` — what placeholders exist? Note each variable's `key`, `is_locale_agnostic`, `description`, and `published_value`.
- `list_workspace_snippets` — same shape, for reusable clauses.
- `list_sites` — confirm the requested brand / site doesn't already exist (avoid duplicates).
- `list_documents` — the documents this brand will serve (e.g. Datenschutzerklärung, Impressum, AGB). Record their `id` and `document_type.code` — you'll need both for the **Verify** step.

You now know the full "shape" of the overrides the new brand will need. Locale-agnostic variables/snippets do not need per-locale overrides (the parent value carries everything); locale-aware ones do.

**Workspace parent values are not language-policed.** A snippet whose `published_blocks` happen to be authored in German renders as German in every locale that has no override — including the English preview. The same is true in reverse. Treat "the parent already fits" as a *content* claim per (locale): a snippet with German parent body fits Termshelf's DE locale but not its EN locale, and vice versa. Plan overrides per axis tuple, scoping only as narrowly as the content actually varies — locale-only is valid when content differs by language but not by brand.

### Picking override scope

`create_variable_override` and `create_snippet_override` both accept `brand_id` as **optional**. Omitting it scopes the override only by `locale` (and optionally market / site_profile). The resolver picks the most specific match: `(brand + locale)` > `(locale)` > workspace parent. Every brand that has no narrower override inherits the locale-only one.

Before adding `brand_id`, ask: **does the content actually differ across brands at this locale?**
- **No** (boilerplate clauses, EU-mandated wording, generic translations) → omit `brand_id`. One override, every brand inherits it.
- **Yes** (per-brand entity names, contact emails, jurisdictional carve-outs) → scope to `brand_id`.

Creating identical per-brand overrides where one locale-only override would do is a smell: it multiplies the surface to publish, multiplies the audit log, and forces every future content edit to be repeated N times.

> **Contract for `is_locale_agnostic: true` variables.** A locale-agnostic variable carries a single workspace-wide value with no per-axis variation. The backend enforces this:
> - `create_variable_override` is rejected (`validation.failed`) if the parent is locale-agnostic AND any of `brand_id` / `market_id` / `site_profile_id` is set.
> - `update_workspace_variable` is rejected (`validation.failed`) if you try to flip `is_locale_agnostic` to `true` while axis-scoped overrides already exist.
>
> Practical guidance: if you might ever need per-brand variation for a value, create the variable with `is_locale_agnostic: false` from the start (even when the value happens not to vary by locale today). Reserve `is_locale_agnostic: true` for genuinely workspace-wide constants (e.g. a shared support phone, an EU-wide SCC clause id) where the answer to "could brand X want a different value?" is "no, ever."

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
| eu_dispute_resolution | — (all brands) | en | EU boilerplate; identical text for every brand, locale-only fallback |
```

Note the second row: when the override content is identical across brands at the same locale, leave the Brand column blank and omit `brand_id` on the call. Reserve brand-scoped overrides for content that genuinely varies per brand.

Then ask: "Approve? (y/N)" — and wait. Do NOT execute until the operator says yes.

### 5. Execute

Once approved, run the writes **in order**:

1. `create_brand` first.
2. `create_site` next, passing `brand_id` from the brand response.
3. `add_domain_to_site` once per domain.
4. `attach_market_to_site` once per market (only if the operator named markets in the proposal).
5. Variable overrides — one call per (variable, locale, target) tuple. For locale-agnostic variables, only one override per target (no locale loop). If the proposal says "fix the existing override on brand X" rather than "create a new one", call `list_variable_overrides` first to fetch the row ID, then `update_variable_override` instead of `create_variable_override`.
6. Snippet overrides — same axis logic. Same fixing pattern: if a brand already has an override on a snippet (a frequent case for brands that were created earlier and seeded with stub drafts), `list_snippet_overrides` → `update_snippet_override`. Use `archive_snippet_override` to retire an override the operator no longer wants; `restore_snippet_override` to bring it back.

Surface each tool's result back briefly ("Brand Acme Legal created (id=42)") so the operator can follow along. If a tool returns `isError: true`, **stop the workflow**. Do not proceed to the next step. Branch on the error code:

| Code | Meaning | What to do |
|---|---|---|
| `auth.bearer_required` | Token missing or invalid | Stop, tell operator to check `TERMSHELF_TOKEN` env and reissue at https://app.termshelf.de/app/settings/api-tokens if needed |
| `abilities.missing` | Token lacks the required ability | Stop, list which ability was missing, tell operator to reissue at https://app.termshelf.de/app/settings/api-tokens |
| `validation.failed` | Body invalid | Show the per-field errors, ask operator how to fix |
| `resource.not_found` | The referenced ID doesn't exist in this workspace | Did you reference the wrong workspace? Ask operator. |
| `resource.conflict` | Domain rule blocked the write (archived, slug collision, …) | Show the message, ask operator how to disambiguate |
| `override.ambiguous` | An override on the same axis tuple already exists (create), or restoring an archived row would tie with a live sibling (restore) | On create: call the corresponding `list_*_overrides` to find the existing row, then `update_*_override` instead. On restore: ask the operator to narrow with another axis (market, profile) or archive the rival first. |
| `rate_limit.exceeded` | Token over its budget | Wait the `retry_after_seconds` and retry once; if still failing, stop |
| `token.workspace_missing` | Token not bound to a workspace | Stop, tell operator to revoke and reissue the token at https://app.termshelf.de/app/settings/api-tokens |
| `transport.unreachable` | The MCP server could not reach the TermShelf host at all (DNS, TLS, port closed) | Stop. Surface the `base_url` from the body and ask the operator to verify `TERMSHELF_BASE_URL` and that the backoffice is reachable. Synthesized by the MCP server — no HTTP request landed. |

### 6. Verify the result against the live preview

**This step is not optional.** Variable and snippet override correctness is invisible from the write responses alone — a `create_*` or `update_*` returning 2xx only proves persistence, not that the rendered document for this brand and locale looks right. The preview is the ground truth, and it now reads from the **draft working tree** (working_blocks of overrides + working_blocks of snippets + draft variable values), so authoring writes show up in the preview immediately — no intermediate publish step required.

For **every** document the brand will publish (you discovered these via `list_documents` in step 2), and for **every** locale the brand supports (from `supported_locale_codes`), call:

```
get_document_preview(document_id=…, brand_id=…, locale=…)
```

Then inspect the response. Treat the loop below as authoritative — do not declare the workflow done until every (document, brand, locale) preview is **clean** on all three signals:

1. **Unresolved variables** — `unresolved_variables` must be `[]`. If a key is listed, the variable has no resolution for this `(brand, locale)`. Decide why:
   - If the workspace `published_value` is null on purpose (brand-specific by design, e.g. `brand.name`, `privacy_policy.contact_email`) → create the missing `create_variable_override(variable_id, brand_id, locale, value)`.
   - If the variable should have a workspace default but doesn't → tell the operator; this is a workspace-level fix, not a brand-level one.
2. **Unresolved snippets** — `unresolved_snippets` must be `[]`. A listed snippet id means the document references a snippet that resolved to nothing for this target. Almost always: the snippet exists but the override scope doesn't match → create `create_snippet_override` for `(brand_id, locale)`. If the id maps to a hard-deleted snippet, tell the operator — that's a workspace bug, not an override gap.
3. **Rendered text quality** — read the `html`. Flag any of:
   - **Cross-locale leakage.** The DE preview must read as German throughout; the EN preview must read as English throughout. If the rendered HTML of a `locale=de` preview contains an English block (the workspace parent of some snippet/variable was authored in English and no DE override exists), the brand needs a DE override for that snippet/variable. Same in reverse for `locale=en`. Common signals: function words like `the / and / for / with` in a DE preview, or `der / die / und / für / mit / nicht` in an EN preview.
   - **Placeholder stubs surviving into the output.** Bare hyphens (`-`), token-style words like `ab`, `TODO`, `TBD`, `[Platzhalter…]`, `<!--`, or single-character "blocks" that look like authoring scaffolding rather than legal copy. These usually mean a workspace parent was never finished and the brand needs a real override.

For each issue you detect, create the missing/corrected override (using the same write tools as step 5), then **re-run `get_document_preview` for the same `(document, brand, locale)`** and re-inspect. Keep iterating until all three signals are clean.

You **must not** declare the workflow done while any preview still surfaces unresolved keys or fails the language / placeholder check. The operator opened this skill so that they don't have to do this inspection themselves — silently leaving locale leakage in the output is the worst-case failure mode for legal text.

Summarize the final state once the loop converges: which `(document, brand, locale)` tuples were verified and which additional overrides were created during verification.

## The document-drafting workflow

When the operator asks for **a new document** (not a brand) — e.g. "draft a privacy policy with this and that snippet", "create a withdrawal-notice document populated from the existing snippets", "set up an imprint for the new German site" — switch to this flow. It overlaps with the brand-onboarding flow but is structured around the document tree rather than around overrides.

### A. Confirm context

Same as the brand flow: `whoami` once at the start. You need `content:read` and `content:write` for this flow.

### B. Discover

In parallel:
- `list_document_types` — to pick the type the new document attaches to. If the requested document type does not exist (`privacy`, `imprint`, `terms`, …), surface this to the operator BEFORE drafting; the type drives the public delivery URL and the taxonomy that later epics (rule packs, applicability) bind to.
- `list_documents` filtered by `document_type_code` — to check whether a document already exists. If one already exists, ask the operator whether to edit the existing draft or create a sibling under a different slug.
- `list_workspace_snippets` — every snippet the operator can reference via `snippet_reference` blocks. Note the `key`, `id`, `title`, and `is_locale_agnostic`. Draft snippets can be referenced too; the publish-time cascade and preview's `unresolved_snippets` array surface any still-unpublished referents before the document goes live.
- `list_workspace_variables` — every `{{key}}` placeholder that may appear inside `heading` / `paragraph` / `list` / `note` / `table` cells. The block payload validator rejects references to unknown keys.
- `list_locales` — the locale codes the workspace operates in. The document's `supported_locale_codes` defaults from the linked site (if any) or workspace default; you can override at create time, but every entry has to exist in the workspace.

### C. Propose a plan

Render a structured proposal back to the operator before any write. Example shape:

```
## Document draft plan — "Privacy Policy" (type=privacy)

### Document
| Field | Value |
|---|---|
| document_type_code | privacy |
| title | Datenschutzerklärung |
| slug | datenschutz (auto from title; will be unique per type) |
| supported_locale_codes | [de, en] |
| default_locale_code | de |
| brand_id | 42 (Acme Legal) |

### Structure (sections, in order)
| # | key | title | What goes inside |
|---|---|---|---|
| 1 | intro | Einleitung | heading + 1 paragraph |
| 2 | controller | Verantwortlicher | heading + paragraph referencing {{company_name}} + {{contact_email}} |
| 3 | rights | Rechte der Betroffenen | heading + reference to snippet `gdpr_rights_clause` |
| 4 | contact | Kontakt | heading + paragraph with {{support_email}} |

### Snippet references
| Section | Snippet key | Snippet id | Notes |
|---|---|---|---|
| rights | gdpr_rights_clause | 17 | already published; renders the standard GDPR rights list |

### Variable references (will be validated at write time)
- company_name, contact_email, support_email — must exist in the workspace; if any is missing, fall back to literal text and tell the operator to add the workspace variable first.
```

Then ask: "Approve? (y/N)" — and wait.

### D. Execute

Once approved, run the writes **in order**:

1. **Pre-flight the dependencies**:
   - Any unknown variable `{{key}}` referenced in the draft → either ask the operator to create them (`create_workspace_variable`), or rewrite the offending text to avoid the reference. Do not silently invent a workspace variable.
   - Snippets referenced by id may be drafts — the write succeeds either way. Snippet references resolve at render time, so the preview will mark unresolved ones in `unresolved_snippets`, and the publish-time cascade refuses to publish a document whose referenced snippets aren't published. Tell the operator about any draft references so they remember to publish those snippets before publishing the document.
   - If the requested `document_type_code` is missing → ask the operator if they want it created (`create_document_type`). Defaulting silently is wrong here: the type is part of the public URL.

2. **Create the document shell** with `create_document`. Pass `document_type_id` (preferred — you got it from `list_document_types`) or `document_type_code`. The action only creates the row + lifecycle status; sections and blocks come next.

3. **Add sections** with `upsert_document_section`, one per section in the proposed order. New sections append at the end, so calling them in the proposal's order Just Works for the initial create. (If you need to author them out of order, call them in any order and then `reorder_document_sections` with the full ordered key list.)

4. **Fill each section with blocks** via `upsert_document_block`. Pass `kind` + the kind-specific `payload`:
   - `heading` → `{ text, level?: 1-6 (default 2) }`. Use `level: 2` for section headings, `level: 3` for sub-headings.
   - `paragraph` → `{ text }`. Variable references are `{{key}}` literal strings inside text — the renderer substitutes them at publish time.
   - `list` → `{ items: [string, …], style?: 'bullet' | 'ordered' }`.
   - `note` → `{ text, severity?: 'info' | 'warning' }`. Useful for operator remarks the publisher should see, e.g. "TODO: confirm processor list".
   - `table` → `{ rows: [[cell, …], …], header?: bool }`. Cells are single-line strings. Every row must have the same column count.
   - `image` → `{ src: absolute http(s) URL, alt?, title? }`. Image bytes are not stored — only URLs.
   - `snippet_reference` → `{ snippet_id }`. Renders the snippet inline at delivery time. The snippet does not have to be published when the block is written, but the publish-time cascade will refuse to publish the document until every referenced snippet is published.

   Each block also needs a stable `key` unique within the document (2–64 chars, must start with a letter, only a-z / 0-9 / underscore / hyphen). Pick semantic keys (`intro_p1`, `rights_ref`) — they show up in audit events and variant overrides bind to them.

5. **Re-order if needed**. If you authored blocks/sections out of the operator's intended order, call `reorder_document_blocks` / `reorder_document_sections` with the full ordered key list.

6. **Add additional locales** with `add_document_locale` once per non-default locale. The server deep-copies the default-locale text into each new locale's translation slot so the SPA opens a populated tab. When the workflow is purely structural (e.g. one locale only), skip this step.

   **Author the translations from this surface.** Both `upsert_document_section` and `upsert_document_block` accept an optional `translations` field that maps `locale → per-locale text`:

   - On sections: `translations: { en: { title: "Provider" } }` — translates the section heading.
   - On blocks: `translations: { en: { text: "The provider of this website is:" } }` — translates the text fragment. Fragment shape is kind-specific; it mirrors the `payload` minus the structural fields (no `level` on headings, no `style` on lists, no `severity` on notes, no `header` on tables — those stay shared across locales). `snippet_reference` blocks have no translatable text; the snippet's own per-locale overrides carry the translation.

   Partial-merge semantics: locales not in the input are left untouched; pass `{ en: null }` (or `{ en: { title: null } }` on sections) to drop a locale entry. Variable references like `{{key}}` work the same inside translation text and are validated identically. Changing a block's `kind` clears any stored translations because the fragment shape becomes stale — re-author them in the same call or a follow-up.

   The document's `title` and `summary` are not yet translatable via this surface; they remain single strings.

7. **Cross-link with the brand-onboarding flow** if applicable. If you just created the document AND the operator is onboarding a brand at the same time, run the **Verify** loop below for the new document under the new brand's `(brand, locale)` tuples. Otherwise verify against the document's `default_locale_code` only.

### E. Verify against the live preview

Same loop as step 6 of the brand flow, but scoped to the new document. For each `(locale ∈ supported_locale_codes)` (and each `brand_id` if a brand-onboarding is in flight), call:

```
get_document_preview(document_id=<the new id>, locale=…, brand_id=…)
```

Inspect `unresolved_variables`, `unresolved_snippets`, and the rendered `html`. Fix every issue by patching the block payload (`upsert_document_block` again with the same `key` — that's an update) or by creating the missing variable/snippet overrides. Keep iterating until the preview is clean.

### F. Stop before publishing

When the document tree is in place and every preview is clean, tell the operator the document ID + the link to the customer-app's authoring view, and ask them to publish. **Do not publish.**

### Editing an existing document

If the operator asks for an edit (not a new document), the same primitives apply:
- `get_document(document_id)` → see the current tree.
- `upsert_document_section` / `upsert_document_block` by the existing `key` → updates that row in place.
- `delete_document_section` / `delete_document_block` → removes; positions are repacked.
- `update_document` → metadata-only edits (title, summary, scope, document_type_id).

Do not mutate keys — the keys are addressing identifiers, and variant overrides reference them. If a key is wrong, delete the row and create a new one with the correct key. Surface this to the operator before executing.

### 7. Stop before publishing

When every override is in place AND every preview is clean, tell the operator:

> "All overrides created and verified — every `(document, brand, locale)` preview renders cleanly. Review them at <link-to-site-or-overrides-page-in-customer-app> and publish when you're satisfied."

You do **not** call any publish endpoint. The token deliberately lacks `publish:trigger`. Publishing requires the operator's eyes on the diff.

## Things you do NOT do

- You do NOT publish content. That's an operator action in the customer-app.
- You do NOT delete or archive existing brands or sites — those represent long-lived structural decisions and the destructive tooling is not exposed here on purpose. (Variable / snippet overrides and workspace-level snippets and variables CAN be edited and archived/deleted via the write tools — but only with explicit operator approval per change.)
- You do NOT use Bash + curl for the management API. Use the MCP tools. They handle auth + error envelopes correctly and never leak the token.
- You do NOT generate integration code for the public delivery API. That's the `termshelf` skill (Tier 1) — it's a separate task and a separate audience (developers consuming published content, not operators authoring it).
- You do NOT silently retry on errors. Each closed-set code has a documented branch; follow it.

## When to ask vs. when to assume

- **Ask** for the brand's URL or a brief before anything else. The whole workflow starts from there.
- **Ask** for any legal-entity detail the URL doesn't surface — name, registered address, jurisdiction. Wrong values in a legal document are the worst possible failure mode.
- **Ask once** before executing the proposed plan. Don't ask per-call; the operator approves the batch.
- **Assume** locales come from `list_locales` — never invent a locale that isn't in the workspace.
- **Assume** translations follow the source locale's tone. If the operator's brief is in German and you need an English translation, produce one and include it in the proposal so the operator can correct before it goes in.
- **Assume the preview is ground truth.** During the Verify step, do not trust your prior planning — re-read every preview and act on what's actually there. A snippet whose parent looked German-enough in `list_workspace_snippets` may still render English in the EN preview (or vice versa), because the parent values are not language-policed.
