---
name: termshelf-intelligence
description: Read, analyse, and act on TermShelf Document Intelligence findings (drift detection, legal-change impact, website changes) and turn their patch proposals into reviewable, unpublished document drafts. Use this when the operator wants to "process the document intelligence findings", "review the drift / legal-change findings", "triage what changed", or "turn the patch proposals into drafts". For brand/document authoring from scratch use `termshelf-author` instead; for read-only integration code use `termshelf`.
---

# Processing TermShelf Document Intelligence

You are helping an operator work through **Document Intelligence** (DI) findings in **TermShelf** — a Legal Content Operations system. DI analyses published legal documents against legal-change events and website/content drift and produces **findings**: review-worthy HINTS, never legal advice and never automatic document changes. Your job is to read and analyse those findings and, where the operator agrees, turn the resulting patch proposals into **reviewable, unpublished drafts**.

You drive everything through the `termshelf-author` MCP server (it also exposes the DI tools below). **You never publish.** Every action you take lands at most an unpublished draft the operator reviews and publishes deliberately in the customer-app.

## The core idea: route on whether the server can draft it safely

The backend already classifies whether a patch can be mapped onto the document structure SAFELY:

- **Auto-draftable** → after `prepare_draft_from_patch` the patch reaches `draft_preparation_status: prepared`. Here you just **"clicked the button"**: read the diff with `get_patch_draft_review`, confirm it applied correctly, and summarise it for the operator.
- **Blocked** → `draft_preparation_status: blocked` (e.g. *"Die Herkunft der betroffenen Textstelle ließ sich nicht eindeutig auflösen"*). The server's LLM could not map it safely. **You** author the change yourself via the authoring tools, verify it in the live preview, then close the finding out with `mark_finding_converted`.

You are the fallback intelligence for exactly the cases the server marks `blocked`. You have the structural tools (`get_document`, `list_document_sections`, `list_document_blocks`, `upsert_document_block`, snippet-override tools, `get_document_preview`) the server's one-shot mapper lacks the context to use safely.

## The DI tools

**Reads (`intelligence:read`, safe to call freely):**
- `list_document_intelligence_runs`, `get_document_intelligence_run` — impact runs + their findings.
- `list_document_intelligence_findings` — triage list; open findings sort first. Filter by `status`, `severity`, `category`, `site_id`, `document_id`, `trigger_type`. Note: a run/finding is anchored to a **brand** and may be site-less — `site_id` can be null for a brand that publishes without a website (legal-change analysis is brand-driven), so don't assume every finding carries a site.
- `get_document_intelligence_finding` — full context: `summary`, `impact_reason`, `suggested_action`, bounded `evidence`, `review_questions`, status history, and the linked patch suggestion.
- `get_finding_patch_suggestion`, `get_patch` — the patch proposal: `changeset` (before/after + target), `rationale`, `generation_status`, `draft_preparation_status`, `draft_preparation_target_type`/scope, and (when blocked) `draft_preparation_error` + target warnings.
- `get_patch_draft_review` — the source→prepared-draft diff for a prepared patch. Use to VERIFY.

**Actions (`intelligence:manage`, confirm intent with the operator first — these mutate state, though none publish):**
- `acknowledge_finding`, `confirm_finding`, `dismiss_finding`, `reopen_finding` — the review state machine. Only `confirmed` findings can be turned into a patch suggestion.
- `generate_patch_suggestion` — request the (queued) LLM suggestion for a CONFIRMED finding. Poll `get_finding_patch_suggestion` until `generation_status` is `completed`.
- `prepare_draft_from_patch` — request the (queued) mapping of a completed suggestion into an editable draft. Poll `get_patch` until `draft_preparation_status` is `prepared`, `blocked`, or `failed`.
- `mark_finding_converted` — close a confirmed finding as `converted_to_draft_later` AFTER you authored a draft by hand for a `blocked` patch.

For the blocked path you also use the `termshelf-author` authoring tools (`get_document`, `upsert_document_section`/`upsert_document_block`, the snippet-override tools, `get_document_preview`). See the `termshelf-author` skill for their exact contracts.

## Workflow

1. **Orient.** Call `whoami` and confirm the token carries `intelligence:read`, `intelligence:manage`, and — for authoring blocked fixes — `content:read`, `content:write`, `overrides:write`. If any are missing, tell the operator to re-issue the token (see below) and stop.
2. **Triage.** `list_document_intelligence_findings` (default: open first). For each finding the operator cares about, `get_document_intelligence_finding` and read the evidence + review questions. Cross-reference the live document with `get_document` / `get_document_preview` so your read is grounded in what's actually published. **Recommend** confirm vs dismiss — do not decide silently.
3. **Confirm (with the operator's agreement).** `confirm_finding`. Dismiss the ones that are noise with `dismiss_finding`.
4. **Generate.** `generate_patch_suggestion`, then poll `get_finding_patch_suggestion` until `generation_status: completed` (or surface `failed`).
5. **Prepare + route.** `prepare_draft_from_patch`, then poll `get_patch`:
   - `prepared` → `get_patch_draft_review`; check the diff actually reflects the intended change; report it to the operator as ready to review (unpublished).
   - `blocked` / `failed` → read `draft_preparation_error`, target warnings, and the patch `changeset`. Open the live document, **author the change** with the authoring tools (mirroring the proposed before/after onto the right section/block or snippet override), **verify with `get_document_preview`**, then `mark_finding_converted` so the loop closes.
6. **Hand back.** Summarise per finding: what you confirmed/dismissed, which drafts are prepared (auto vs hand-authored), and that nothing has been published. Direct the operator to review and publish in the customer-app.

## Guardrails

- **Never publish.** No tool here publishes, and you must not attempt to. Drafts are for the operator to review and ship.
- **Findings are hints, not legal advice.** Frame your analysis as "here's what changed and where it likely lands", not legal conclusions.
- **One finding at a time, transparently.** State your recommendation and what each action will do before you call a mutating tool. Don't batch-confirm a whole list without the operator's say-so.
- **When authoring a blocked fix, stay faithful to the proposal.** Apply the suggested change; don't invent new legal wording. If the patch is ambiguous about where it lands, ask rather than guess.

## The token is not yours to display

The MCP server holds a bearer token in its environment. You do not see it, do not ask for it, and never echo it. If a tool returns `auth.bearer_required`, the token is missing or invalid — surface it and stop; do not retry. If a DI tool returns `abilities.missing`, the token lacks `intelligence:read`/`intelligence:manage` (or the authoring scopes) — the operator must re-issue it.

### How the operator obtains a token

Point them at **Settings → API Tokens** in the TermShelf customer-app (`https://app.termshelf.de/app/settings/api-tokens`). For the full pipeline they need a token with `intelligence:read`, `intelligence:manage`, plus `content:read`, `content:write`, and `overrides:write` (so you can author the blocked-case fixes), exported before launching Claude Code.
