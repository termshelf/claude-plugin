# TermShelf Claude Code plugin

Integrate [TermShelf](https://termshelf.de) — a Legal Content Operations system — into your website or app with one prompt.

This plugin teaches Claude Code how to consume the TermShelf Public Delivery API: how to construct URLs, how to cache responses, which classes to style, and what idiomatic integration code looks like for popular frameworks (Next.js, Astro, SvelteKit, Express, Laravel Blade, plain HTML).

It does **not** call any TermShelf service or transmit any data on your behalf — the skill is just instructions Claude follows to generate code locally.

## Install

In Claude Code:

```text
/plugin marketplace add termshelf/claude-plugin
/plugin install termshelf@termshelf
```

Or test locally before publishing — from inside Claude Code, point `/plugin marketplace add` at a local clone of this repo:

```text
/plugin marketplace add /absolute/path/to/termshelf-claude-plugin
/plugin install termshelf@termshelf
```

## Use

Once installed, ask Claude in plain language:

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

Claude will ask for whichever of these it still needs:

- your **account hash** (10-char Crockford base32)
- your **site slug**
- the **document type code** (`privacy_policy`, `imprint`, `terms`, `withdrawal`, `cookie_policy`, …)
- the **target tuple** (locale + optionally market + site profile)
- your **public-API base URL** (`https://api.termshelf.de` or `https://api.termshelf.com` — both serve the same content; pick the apex your workspace lives on)

> **Shortcut**: open your TermShelf customer-app → avatar dropdown (top right) → **"Integration reference"**. The page lists every value above on one screen. Hit **"Copy integration context"** and paste the blob into the chat — Claude parses it and skips the questions.

It then generates a working integration: fetch with proper ETag handling, the right component for your framework, and a starter stylesheet for the `ts-document` class hierarchy.

## What's inside

```
.
├── .claude-plugin/
│   ├── marketplace.json        # marketplace catalog (single plugin)
│   └── plugin.json             # plugin manifest
└── skills/
    └── termshelf/
        ├── SKILL.md            # the instructions Claude follows
        ├── reference/
        │   ├── api-contract.md # URL shape, query params, response envelope
        │   ├── caching.md      # ETag + Cache-Control patterns
        │   └── styling.md      # ts-document / ts-section / ts-block classes
        └── templates/
            ├── nextjs.tsx      # App Router server component
            ├── astro.astro     # Astro page fragment
            ├── express.js      # Express + node-fetch + in-memory cache
            ├── laravel.blade.php # Blade partial via Http::get
            └── styles.css      # Drop-in stylesheet for ts-document
```

## Limits

This is the **Tier 1** skill: read-only on the developer's side, generates integration code only. It does not call any TermShelf API on your behalf, does not require an API key, and does not modify your TermShelf workspace.

A future Tier 2 may call a small read-only TermShelf endpoint to look up your sites and document type codes automatically. That tier will require an API key and runs against authoring data; it's deliberately not part of this skill.

## License

MIT — see [LICENSE](LICENSE).
