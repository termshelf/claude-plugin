# Caching the TermShelf Public Delivery API

Every response carries `ETag`, `Cache-Control`, and `Last-Modified` headers. **Always wire them in the generated code.** Skipping the cache is the difference between hitting the API on every page render and hitting it once a minute.

## What the API tells you

```
ETag: "v3-a1f2c8d…"
Cache-Control: public, max-age=60, stale-while-revalidate=30
Last-Modified: Tue, 21 Apr 2026 09:30:10 GMT
X-Termshelf-Document-Version: 3
```

The `ETag` changes whenever the served bytes change — same etag means safe-to-reuse. Use it as your strong validator and ignore `Last-Modified` unless you specifically need the timestamp.

## Conditional GET pattern

```
GET …  If-None-Match: "v3-a1f2c8d…"

→ 304 Not Modified           # bytes unchanged, reuse cached body
→ 200 OK + new ETag          # bytes changed, replace cached body
```

## Per-framework patterns

### Next.js App Router (server component)

The framework's built-in revalidation handles the cache for you:

```ts
const res = await fetch(url, { next: { revalidate: 60 } });
const html = await res.text();
```

Next.js + the platform's CDN respects upstream `Cache-Control` automatically. Setting `revalidate` to the same window as the upstream `max-age` (60s by default) keeps the framework cache and the API cache in sync.

For Pages Router, use `getStaticProps` with `revalidate: 60`.

### Astro

```astro
---
const res = await fetch(url);          // Astro respects Cache-Control by default
const html = await res.text();
---
<div set:html={html} />
```

For higher hit rates set `output: 'static'` and rebuild on a schedule, or `output: 'hybrid'` with on-demand revalidation.

### Express / Node

Use a small in-memory cache keyed by URL with `If-None-Match` revalidation:

```js
const cache = new Map();   // url → { etag, body, expires }

async function fetchTermShelf(url) {
  const now = Date.now();
  const entry = cache.get(url);
  const headers = entry?.etag ? { 'If-None-Match': entry.etag } : {};

  // Serve from cache if not yet expired and not stale.
  if (entry && now < entry.expires) return entry.body;

  const res = await fetch(url, { headers });
  if (res.status === 304 && entry) {
    cache.set(url, { ...entry, expires: now + 60_000 });
    return entry.body;
  }

  const body = await res.text();
  cache.set(url, { etag: res.headers.get('etag'), body, expires: now + 60_000 });
  return body;
}
```

### Laravel

```php
$response = Http::withHeaders([
    'If-None-Match' => Cache::get("termshelf.etag.{$cacheKey}", ''),
])->get($url);

if ($response->status() === 304) {
    return Cache::get("termshelf.body.{$cacheKey}");
}

Cache::put("termshelf.etag.{$cacheKey}", $response->header('ETag'), 60);
Cache::put("termshelf.body.{$cacheKey}", $response->body(),         60);
return $response->body();
```

### CDN (Cloudflare / Fastly / Varnish)

Just put the public-API behind your edge. The upstream `Cache-Control: public, max-age=60` is honoured automatically. Set the cache key to `(host, path, query)` — the API guarantees identical responses for identical query strings, so adding more keys won't increase hit rate.

## What to cache vs. not

| Status | Cache it? |
|---|---|
| `200 OK` | Yes, until the etag changes or `max-age` lapses |
| `304 Not Modified` | No body to cache; refresh the cached entry's expiry |
| `404 Not Found` | Briefly (~30s). Avoids spamming the API for documents that aren't published yet, but lets a publish propagate quickly. |
| `409 version_mismatch` | No — the response means your pin is stale, surface it. |
| `429 quota_exceeded` | No — back off and retry later. |
| `5xx` | No — transient. |

## Don't do this

- **Don't disable the cache** because "the document changes when we publish". Publishing changes the etag; conditional GET handles it.
- **Don't pin `?version=N` long-term.** Use it for dev/staging or drift detection; in production let the API serve the live version so a publish reaches your readers.
- **Don't cache PDF binaries beyond the upstream `max-age`.** They can be replaced at publish and are large.
