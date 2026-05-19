// routes/legal.js — Express router that serves TermShelf legal texts with
// in-memory ETag caching. Wire into your app via `app.use("/legal", router)`.

import { Router } from "express";

// Use https://api.termshelf.de (German market) or https://api.termshelf.com (international).
// Both serve the same content — pick whichever matches your TermShelf workspace apex.
const TERMSHELF_BASE = process.env.TERMSHELF_PUBLIC_API_BASE_URL ?? "https://api.termshelf.de";
const ACCOUNT_HASH = process.env.TERMSHELF_ACCOUNT_HASH ?? "K57CDHNXYQ"; // 10-char Crockford base32
const SITE_SLUG = process.env.TERMSHELF_SITE_SLUG ?? "main-site";       // renaming invalidates the URL

const cache = new Map(); // url → { etag, body, expires }

async function fetchTermShelf(typeCode, query) {
  const params = new URLSearchParams(query);
  const url = `${TERMSHELF_BASE}/v1/delivery/${ACCOUNT_HASH}/${SITE_SLUG}/documents/${typeCode}/html?${params}`;
  const now = Date.now();
  const entry = cache.get(url);
  const headers = entry?.etag ? { "If-None-Match": entry.etag } : {};

  if (entry && now < entry.expires) return entry.body;

  const res = await fetch(url, { headers });
  if (res.status === 304 && entry) {
    cache.set(url, { ...entry, expires: now + 60_000 });
    return entry.body;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TermShelf ${res.status}`);

  const body = await res.text();
  cache.set(url, { etag: res.headers.get("etag") ?? "", body, expires: now + 60_000 });
  return body;
}

export const router = Router();

// Map URL route → TermShelf type code. Routes stay short for end users;
// the API call uses the seeded baseline codes (privacy_policy, imprint,
// terms, withdrawal, cookie_policy).
const ROUTES = {
  privacy: "privacy_policy",
  imprint: "imprint",
  terms: "terms",
};

for (const [route, typeCode] of Object.entries(ROUTES)) {
  router.get(`/${route}`, async (_req, res, next) => {
    try {
      // Use the bare locale code your workspace publishes under (`de`, `en`).
      const fragment = await fetchTermShelf(typeCode, { locale: "de", market: "DE" });
      if (fragment === null) return res.status(404).send("Not yet published.");
      res.type("html");
      res.send(`<!doctype html><html lang="de"><head><meta charset="utf-8">
        <link rel="stylesheet" href="/termshelf.css"></head>
        <body><main class="ts-host">${fragment}</main></body></html>`);
    } catch (e) {
      next(e);
    }
  });
}
