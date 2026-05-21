# TermShelf Claude Code plugin

Two skills for working with [TermShelf](https://termshelf.de), a Legal Content Operations system:

| Skill | Audience | What it does |
|---|---|---|
| `termshelf`        | **Developers** | Generate read-only integration code (Next.js / Astro / Express / Laravel / …) that consumes already-published legal texts via the TermShelf Public Delivery API. No credentials needed. |
| `termshelf-author` | **Operators**  | Drive a brand-onboarding or document-drafting workflow end-to-end against the TermShelf Management API — create brands, sites, domains, document types, full documents (sections + blocks with snippet references), and per-locale variable / snippet overrides via an MCP server. Requires a token. **Stops before publishing.** |

## Install

In Claude Code:

```text
/plugin marketplace add termshelf/claude-plugin
/plugin install termshelf@termshelf
```

Or for local testing — from inside Claude Code, point `/plugin marketplace add` at a local clone:

```text
/plugin marketplace add /absolute/path/to/termshelf-claude-plugin
/plugin install termshelf@termshelf
```

## Tier 1 — `termshelf` (developer-facing)

Ask Claude in plain language:

```text
Add my TermShelf privacy policy to this Next.js app.
```

```text
Embed the TermShelf imprint as an HTML fragment into my Astro site,
caching for 5 minutes.
```

```text
Generate a Laravel Blade partial that fetches my TermShelf terms
in JSON and renders them with my own template.
```

Claude will ask for whichever of these it still needs (account hash, site slug, document type code, target locale, …) and produces a working integration with proper ETag caching, framework-idiomatic placement, and a starter stylesheet for the `ts-document` classes.

> **Shortcut**: open your TermShelf customer-app → avatar dropdown → **"Integration reference"**. The page lists everything Claude needs on one screen. Click **"Copy integration context"** and paste the blob into the chat — Claude parses it and skips the questions.

This tier does NOT call any TermShelf service on your behalf. It generates code locally.

## Tier 2 — `termshelf-author` (operator-facing)

This tier **does** call TermShelf — it drives the `/api/v1/management/*` surface programmatically.

### One-time setup

After installing the plugin, install the MCP server's Node dependencies:

```sh
cd "$(claude code plugins root)/termshelf/mcp-server"   # or your manual clone path
npm install
```

Then issue a Management API token in the customer-app (**Settings → API Tokens**) with the scopes you want Claude to have:

| Scope | What it grants |
|---|---|
| `structure:read`   | List sites + their domains, markets, profiles |
| `content:read`     | List workspace variables, snippets, locales, documents, document types |
| `structure:write`  | Create brands, sites, domains, attach markets |
| `overrides:write`  | Create per-locale variable and snippet overrides |
| `content:write`    | Create / edit workspace snippets + variables, document types, full documents (sections + blocks) |

For the typical brand-onboarding workflow, the first four. For drafting whole documents, add `content:write`. **Do NOT** include `publish:trigger` — publishing stays in your hands inside the customer-app.

Export the token before launching Claude Code:

```sh
export TERMSHELF_TOKEN=<your-token>
# For local development:
# export TERMSHELF_BASE_URL=http://app.termshelf.local:9191
```

The MCP server reads the token from the environment and **never** echoes it. If you ever see it in a Claude transcript, rotate it.

### Use

Two flavours of prompt are supported:

```text
Onboard "Acme Legal GmbH" (https://acme.de) as a new brand under my workspace.
Create the site, domain, and the per-locale variable + snippet overrides
needed for the documents we already have. Stop before publishing.
```

```text
Draft a Datenschutzerklärung document of type "privacy" for the Acme brand.
Use our existing gdpr_rights_clause snippet for the "Rechte der Betroffenen"
section and pull company_name + contact_email from variables. Stop before
publishing.
```

Claude will:

1. Discover existing variables / snippets / locales / documents / document types in your workspace.
2. Fetch the brand's website and (if needed) ask you for missing legal entity details, OR analyse the requested document's structure.
3. Produce a structured plan as a markdown table.
4. Wait for your explicit approval.
5. Execute the plan — brand, site, domain, market, document, sections, blocks, variable + snippet overrides.
6. Verify each `(document, brand, locale)` against the live preview and iterate.
7. Hand back to you with a link to review the result and hit **Publish** in the customer-app.

See [`skills/termshelf-author/SKILL.md`](skills/termshelf-author/SKILL.md) for the full workflow + error-handling contract.

## What's inside

```
.
├── .claude-plugin/
│   ├── marketplace.json        # marketplace catalog (single plugin)
│   └── plugin.json             # plugin manifest + MCP server registration
├── mcp-server/                 # Tier 2 — Node MCP server
│   ├── index.mjs               # tool definitions for /api/v1/management/*
│   ├── package.json
│   └── README.md               # setup + tool reference
└── skills/
    ├── termshelf/              # Tier 1 — read-only integration helper
    │   ├── SKILL.md
    │   ├── reference/
    │   │   ├── api-contract.md
    │   │   ├── caching.md
    │   │   └── styling.md
    │   └── templates/
    │       ├── nextjs.tsx
    │       ├── astro.astro
    │       ├── express.js
    │       ├── laravel.blade.php
    │       └── styles.css
    └── termshelf-author/       # Tier 2 — operator-facing workflow
        └── SKILL.md
```

## Boundaries

- **Tier 1 (`termshelf`)** is read-only on the developer's side. It does not call any TermShelf API and does not require a token.
- **Tier 2 (`termshelf-author`)** calls the Management API on your behalf, but only via the MCP server's typed tools. It does NOT call any read-only delivery endpoint. It does NOT publish.
- Tier 2 deliberately leaves publishing to the operator. The token must not carry `publish:trigger`.
- The two skills coexist; Claude picks the right one based on whether you're trying to embed published content (Tier 1) or author content / structure (Tier 2).

## License

MIT — see [LICENSE](LICENSE).
