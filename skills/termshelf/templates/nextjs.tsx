// app/legal/privacy/page.tsx — Next.js App Router server component.
// Replace ACCOUNT_HASH, SITE_SLUG, TYPE_CODE, and the locale/market/profile to match your TermShelf workspace.

// Use https://api.termshelf.de (German market) or https://api.termshelf.com (international).
// Both serve the same content — pick whichever matches your TermShelf workspace apex.
const TERMSHELF_BASE = process.env.TERMSHELF_PUBLIC_API_BASE_URL ?? "https://api.termshelf.de";
const ACCOUNT_HASH = "K57CDHNXYQ";        // 10-char Crockford base32, from the document Links tab
const SITE_SLUG = "main-site";            // renaming the slug invalidates this URL
const TYPE_CODE = "privacy_policy"; // seeded baseline codes: privacy_policy | imprint | terms | withdrawal | cookie_policy

export const revalidate = 60; // match upstream Cache-Control: max-age=60

export default async function PrivacyPage() {
  const url =
    `${TERMSHELF_BASE}/v1/delivery/${ACCOUNT_HASH}/${SITE_SLUG}/documents/${TYPE_CODE}/html` +
    // Use the bare locale code your workspace publishes under (`de`, `en`).
    // Region-qualified codes like `de-DE` will 404 unless the workspace
    // explicitly configured them.
    `?locale=de&market=DE&profile=B2C`;

  const res = await fetch(url, { next: { revalidate } });

  if (res.status === 404) {
    // No projection yet — render a soft fallback rather than a 500.
    return <main className="prose mx-auto p-6">Datenschutzerklärung wird vorbereitet.</main>;
  }
  if (!res.ok) {
    throw new Error(`TermShelf delivery failed: ${res.status}`);
  }

  const fragment = await res.text();
  return (
    <main className="ts-host mx-auto max-w-3xl p-6">
      <div dangerouslySetInnerHTML={{ __html: fragment }} />
    </main>
  );
}
