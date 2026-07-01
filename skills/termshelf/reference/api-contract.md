# TermShelf Public Delivery API contract (v1)

Authoritative reference for code-generation. Mirror of the contracts declared in `apps/public-api/internal/delivery/{jsonapi,htmlapi,pdfapi}/contract.go`.

## Endpoints

Site route (compatibility path):

```
GET {base}/v1/delivery/{accountHash}/{siteSlug}/documents/{typeCode}        application/json
GET {base}/v1/delivery/{accountHash}/{siteSlug}/documents/{typeCode}/html   text/html; charset=utf-8
GET {base}/v1/delivery/{accountHash}/{siteSlug}/documents/{typeCode}/pdf    application/pdf
```

Brand route (content published without a website):

```
GET {base}/v1/brands/{accountHash}/{brandSlug}/documents/{typeCode}         application/json
GET {base}/v1/brands/{accountHash}/{brandSlug}/documents/{typeCode}/html    text/html; charset=utf-8
GET {base}/v1/brands/{accountHash}/{brandSlug}/documents/{typeCode}/pdf     application/pdf
```

Both routes serve the same published projection, take the same query params, and return the same envelope shape (only the `target` identity differs — see below). Every projection row is brand-tagged, so a site's content is reachable by its brand too; use the brand route when a brand delivers without a site.

Path params:

- `accountHash` — string. The owning account's immutable public hash (10-char Crockford base32, e.g. `K57CDHNXYQ`). Globally unique; isolates one customer's URL namespace from every other.
- `siteSlug` — string (site route). The site's slug, unique within the account. Renaming the slug invalidates every live URL; the Backoffice guards rename behind an explicit confirm.
- `brandSlug` — string (brand route). The brand's slug, unique within the account.
- `typeCode` — string. Stable code. The five seeded baseline codes are `privacy_policy`, `imprint`, `terms`, `withdrawal`, `cookie_policy`. Custom workspace-defined codes are also valid.

Note: the numeric identity is still returned in the JSON response body for diagnostics/analytics — `target.site_id` on the site route, `target.brand_id` on the brand route; neither is part of the URL.

Query params:

- `locale=<code>` — required when the projection row's `locale_code` is non-null (the typical case). The string must match the workspace's published locale exactly; lookup is lowercased so `DE` and `de` are equivalent, but `de` and `de-DE` are NOT equivalent — they are distinct projection rows. TermShelf's default workspace locales are bare language tags (`de`, `en`).
- `market=<code>` — optional. Workspace-stable code.
- `profile=<code>` — optional. Workspace-stable code.
- `version=<int>` — optional pin. 409 with `error.code=version_mismatch` if the live version is not N.
- `effective_at=<ISO 8601>` — optional point-in-time lookup. Mutually exclusive with `version`.

No `Authorization` header. Per-site entitlement gating happens server-side based on the workspace's TermShelf plan.

## JSON response envelope

```json
{
  "schema_version": 1,
  "api_version": "v1",
  "document": {
    "type_code":  "privacy_policy",
    "slug":       "privacy-policy",
    "title":      "…",
    "summary":    null
  },
  "target": {
    "account_hash":      "K57CDHNXYQ",
    "site_id":           42,
    "site_slug":         "main-site",
    "locale_code":       "de",
    "market_code":       "DE",
    "site_profile_code": "B2C"
  },
  "version": {
    "number":       3,
    "captured_at":  "2026-04-20T12:00:00Z",
    "published_at": "2026-04-21T09:30:00Z"
  },
  "sections": [
    {
      "key":      "main",
      "title":    "…",
      "position": 0,
      "blocks":   [ /* see Block kinds below */ ]
    }
  ],
  "meta": {
    "etag":               "\"v3-5b68f6…\"",
    "built_at":           "2026-04-21T09:30:10Z",
    "first_published_at": "2026-04-10T08:00:00Z"
  }
}
```

`schema_version` and `api_version` let you fence consumers against future breaking changes — pin both in your code.

**Target identity by route.** On the **site** route, `target` carries `site_id` + `site_slug` (as above). On the **brand** route, it carries `brand_id` + `brand_slug` and omits the site fields:

```json
"target": {
  "account_hash":      "K57CDHNXYQ",
  "brand_id":          7,
  "brand_slug":        "acme-brand",
  "locale_code":       "de",
  "market_code":       null,
  "site_profile_code": null
}
```

Treat all four id/slug fields as optional and read whichever pair is present. Everything else in the envelope is identical across routes.

### Block kinds

| `kind` | Stable payload fields |
|---|---|
| `heading` | `level: 2..6` (int), `text: string` |
| `paragraph` | `text: string` |
| `list` | `style: "bullet" \| "ordered"`, `items: string[]` |
| `note` | `severity: "info" \| "warning"`, `text: string` |
| `table` | `rows: string[][]`, `header?: bool`, `cell_attrs?: { colspan?, rowspan?, backgroundColor? }[][]` |
| `image` | `src: string`, `alt?: string`, `title?: string` |

Snippet references and `{{variable}}` tokens are **already resolved** — consumers never see them.

Forward-compat: a future block kind would arrive as an unknown `kind`. Keep your renderer defensive (`switch` with a `default` branch that emits the block's `payload.text` if present and otherwise nothing).

## HTML response

`Content-Type: text/html; charset=utf-8`. Self-contained `<article class="ts-document">` fragment — no `<head>`, no `<body>`, no chrome.

Stable class hierarchy:

```html
<article class="ts-document"
         data-document-type-code="privacy_policy"
         data-document-slug="…"
         data-document-version="3"
         data-locale="de"
         data-market="DE"
         data-site-profile="B2C"
         lang="de">

  <header class="ts-document__header">              <!-- only when summary set -->
    <p class="ts-document__summary">…</p>
  </header>

  <section class="ts-section" data-section-key="main">
    <h2 class="ts-section__title">…</h2>

    <h3 class="ts-block ts-block--heading ts-block__heading"
        data-block-key="…" data-heading-level="3">…</h3>

    <div class="ts-block ts-block--paragraph" data-block-key="…">
      <p>…</p>
    </div>

    <div class="ts-block ts-block--list" data-block-key="…">
      <ul><li>…</li></ul>          <!-- or <ol> for ordered -->
    </div>

    <aside class="ts-block ts-block--note" role="note"
           data-block-key="…" data-severity="info">
      <p>…</p>
    </aside>

    <div class="ts-block ts-block--table" data-block-key="…">
      <table><thead/><tbody/></table>
    </div>

    <figure class="ts-block ts-block--image" data-block-key="…">
      <img src="…" alt="…" loading="lazy" referrerpolicy="no-referrer">
    </figure>
  </section>
</article>
```

All text is HTML-escaped at render time. The renderer never trusts authoring to emit raw HTML.

## PDF response

`Content-Type: application/pdf` with `Content-Disposition: attachment; filename="…"` and the same caching headers as JSON/HTML. Binary body.

## Response headers (every artifact)

- `ETag: "v<N>-<hash>"` — strong validator.
- `Cache-Control: public, max-age=60, stale-while-revalidate=30` (PDF: `max-age=300`).
- `Last-Modified: <RFC 7231>`.
- `X-Termshelf-Document-Version: <N>`.
- `X-Termshelf-Published-At: <ISO 8601>`.

Conditional `GET`: send `If-None-Match: "<previous etag>"`, expect `304 Not Modified` (no body) when unchanged.

## Error envelope

```json
{ "error": { "code": "not_found", "message": "…" } }
```

Codes:

| Code | HTTP | Meaning |
|---|---|---|
| `not_found` | 404 | Unknown `(accountHash, siteSlug)` / `(accountHash, brandSlug)` pair, or no live projection row for `(site\|brand, type, locale, market, profile)` |
| `invalid_request` | 400 | Malformed path or query parameter |
| `unsupported_version` | 400 | Unknown `?api=` value |
| `version_mismatch` | 409 | Pinned `?version=N` no longer live; body has current number |
| `entitlement_required` | 403 | Workspace plan doesn't include this artifact |
| `quota_exceeded` | 429 | Monthly delivery API budget exhausted |
| `method_not_allowed` | 405 | Wrong HTTP method |
| `internal` | 500 | Server fault. Retry with backoff. |
