# Styling the TermShelf HTML fragment

The `/html` endpoint returns a self-contained `<article class="ts-document">` fragment. The class hierarchy is stable — you style it once and every document on every site looks consistent.

A document **without these styles renders unstyled** and looks broken. When generating an HTML embed, always offer the developer a starter stylesheet.

## Class hierarchy

```
.ts-document
.ts-document__header         ← only emitted when summary is set
.ts-document__summary        ← <p>

.ts-section
.ts-section__title           ← <h2>

.ts-block.ts-block--heading.ts-block__heading      ← <h2>..<h6>
.ts-block.ts-block--paragraph                      ← <div><p>
.ts-block.ts-block--list                           ← <div><ul|ol>
.ts-block.ts-block--note  + role="note"            ← <aside><p>
   ├── [data-severity="info"]
   └── [data-severity="warning"]
.ts-block.ts-block--table                          ← <div><table>
.ts-block.ts-block--image                          ← <figure><img>
.ts-block.ts-block--unknown                        ← forward-compat fallback
```

Data attributes you can hook into:

- `data-section-key`, `data-block-key` — stable identifiers for analytics or anchor links.
- `data-document-version` — current version number, useful for footer "last updated" displays.
- `data-locale`, `data-market`, `data-site-profile` — for conditional CSS.
- `data-heading-level` — duplicates the tag (`h3` etc.) for selector convenience.

## Drop-in starter stylesheet

```css
/* TermShelf — minimal starter. Tweak typography to match your site. */

.ts-document {
  max-width: 72ch;
  margin: 0 auto;
  font-family: -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, sans-serif;
  font-size: 1rem;
  line-height: 1.65;
  color: #1a1a1a;
}

.ts-document__header {
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e5e5e5;
}
.ts-document__summary { margin: 0; color: #555; font-size: 1.05rem; }

.ts-section { margin-top: 2.5rem; }
.ts-section:first-of-type { margin-top: 0; }
.ts-section__title { font-size: 1.5rem; font-weight: 600; margin: 0 0 1rem; letter-spacing: -0.01em; }

.ts-block { margin: 1em 0; }

.ts-block--heading { margin: 1.5em 0 .5em; font-weight: 600; line-height: 1.3; }
h2.ts-block--heading { font-size: 1.5rem; }
h3.ts-block--heading { font-size: 1.25rem; }
h4.ts-block--heading { font-size: 1.1rem; }
h5.ts-block--heading,
h6.ts-block--heading { font-size: 1rem; }

.ts-block--paragraph p { margin: 0; }

.ts-block--list ul,
.ts-block--list ol { margin: 0; padding-left: 1.5rem; }
.ts-block--list li { margin: .25em 0; }

.ts-block--note {
  padding: .75rem 1rem;
  border-left: 3px solid #2563eb;
  background: #eff6ff;
  border-radius: 4px;
}
.ts-block--note[data-severity="warning"] {
  border-left-color: #d97706;
  background: #fffbeb;
}
.ts-block--note p { margin: 0; }

.ts-block--table table { border-collapse: collapse; width: 100%; }
.ts-block--table th,
.ts-block--table td { border: 1px solid #d4d4d4; padding: .5rem .75rem; text-align: left; }
.ts-block--table th { background: #f5f5f5; font-weight: 600; }

.ts-block--image img { max-width: 100%; height: auto; border-radius: 4px; }

.ts-block--unknown {
  /* Forward-compat. A future block kind shows here until you style it. */
  padding: .5rem .75rem;
  border: 1px dashed #f87171;
  background: #fef3f2;
  color: #991b1b;
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: .85rem;
}
```

## Tailwind alternative

If the host site uses Tailwind, generate a `prose` wrapper instead:

```tsx
<div
  className="prose prose-slate max-w-prose mx-auto"
  dangerouslySetInnerHTML={{ __html: html }}
/>
```

You'll still want a thin override for the `ts-block--note` and `ts-block--unknown` cases since `prose` doesn't style those.

## Dark mode

Wrap the starter in a `prefers-color-scheme` media query or duplicate the rules under your site's existing dark-mode selector. The fragment doesn't ship its own dark-mode CSS — it inherits from the host page.
