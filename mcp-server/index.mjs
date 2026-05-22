#!/usr/bin/env node
/**
 * TermShelf MCP server (MX phase 3, ADR-058).
 *
 * Exposes the `/api/v1/management/*` surface as typed MCP tools so a
 * Claude Code session can drive a brand-onboarding workflow without
 * the operator copy-pasting curl recipes.
 *
 * Configuration (env):
 *   - TERMSHELF_TOKEN     (required)  bearer token issued from the
 *                                     customer-app Settings → API Tokens
 *                                     page (see MX-E02). The server
 *                                     refuses to start without it and
 *                                     NEVER echoes it back through any
 *                                     tool result or log.
 *   - TERMSHELF_BASE_URL  (optional)  defaults to https://app.termshelf.de
 *                                     For local dev, point at e.g.
 *                                     http://app.termshelf.local:9191
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- configuration ----------------------------------------------------------

const TOKEN = process.env.TERMSHELF_TOKEN;
const BASE_URL = (process.env.TERMSHELF_BASE_URL ?? "https://app.termshelf.de").replace(
  /\/+$/,
  "",
);

if (!TOKEN || TOKEN.trim() === "") {
  process.stderr.write(
    "TERMSHELF_TOKEN env var is required.\n" +
      "Issue a token in the TermShelf customer-app: Settings → API Tokens.\n" +
      "Then export TERMSHELF_TOKEN=<value> before launching the MCP server.\n",
  );
  process.exit(2);
}

// --- HTTP client ------------------------------------------------------------

/**
 * Call the management API. Returns a normalized envelope:
 *   { ok: true, status, data }    on 2xx
 *   { ok: false, status, error }  on 4xx/5xx — `error` is the JSON body
 *
 * The bearer token is added here and NEVER appears in tool input/output —
 * callers see the body but not the credential.
 */
async function callManagement(method, path, { body, idempotencyKey } = {}) {
  const url = `${BASE_URL}/api/v1/management${path}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure (host unreachable, DNS, TLS, …). Map to a
    // closed-set transport code so the skill can branch on it. The
    // error message is the network library's text; we deliberately do
    // not include URL or headers because the latter carry the bearer.
    return {
      ok: false,
      status: 0,
      error: {
        message: err?.message ?? "Network request failed.",
        code: "transport.unreachable",
        base_url: BASE_URL,
      },
    };
  }

  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }

  if (response.ok) {
    return { ok: true, status: response.status, data: parsed };
  }
  return { ok: false, status: response.status, error: parsed };
}

/**
 * Format an MCP tool result.
 *
 * Success: textual JSON payload (Claude parses it back).
 * Failure: textual envelope + `isError: true`. Closed-set codes from the
 * server (auth.bearer_required, abilities.missing, validation.failed,
 * resource.not_found, resource.conflict, override.ambiguous,
 * rate_limit.exceeded, token.workspace_missing) flow through verbatim so
 * the skill can branch on them.
 */
function asToolResult(result) {
  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            http_status: result.status,
            ...result.error,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// --- reusable schema fragments ---------------------------------------------

const overrideAxes = {
  brand_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Restrict the override to a specific brand. Combine with locale and optionally market/site_profile to narrow the axis tuple.",
    ),
  market_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Restrict the override to a specific market."),
  site_profile_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Restrict the override to a specific site profile."),
};

const paginationInput = {
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Page number (1-indexed). Defaults to 1."),
  per_page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Rows per page. Default and maximum vary by endpoint."),
};

const idempotencyInput = {
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Optional Idempotency-Key header. Same (token, route, key) tuple replays the original response within a 24h window — set this when retrying a previous request.",
    ),
};

// --- server + tools ---------------------------------------------------------

const server = new McpServer({
  name: "termshelf",
  version: "0.9.0",
});

// === Read tools ============================================================

server.tool(
  "whoami",
  "Confirm authentication and return the bound user, workspace, and the active token's metadata. Use this to verify the MCP server is correctly configured and the token has the expected abilities.",
  {},
  async () => asToolResult(await callManagement("GET", "/whoami")),
);

server.tool(
  "list_sites",
  "List sites in the active workspace. Paginated; supports filtering by brand_id and status.",
  {
    brand_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only return sites linked to this brand."),
    status: z
      .enum(["active", "archived"])
      .optional()
      .describe("Filter by site status."),
    ...paginationInput,
  },
  async ({ brand_id, status, page, per_page }) => {
    const params = new URLSearchParams();
    if (brand_id !== undefined) params.set("brand_id", String(brand_id));
    if (status) params.set("status", status);
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));
    const qs = params.toString();
    return asToolResult(
      await callManagement("GET", `/sites${qs ? `?${qs}` : ""}`),
    );
  },
);

server.tool(
  "get_site",
  "Fetch a single site by ID, including embedded domains, supported markets, and supported site profiles.",
  {
    site_id: z.number().int().positive().describe("Site row ID."),
  },
  async ({ site_id }) =>
    asToolResult(await callManagement("GET", `/sites/${site_id}`)),
);

server.tool(
  "list_workspace_variables",
  "List workspace variables (the {{key}} placeholders embedded in document content). Each row exposes the published value, the is_locale_agnostic flag, and the count of existing overrides. Use this before deciding which variables a brand needs per-locale overrides for.",
  {
    q: z
      .string()
      .optional()
      .describe("Substring filter against key + description."),
    ...paginationInput,
  },
  async ({ q, page, per_page }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));
    const qs = params.toString();
    return asToolResult(
      await callManagement("GET", `/workspace-variables${qs ? `?${qs}` : ""}`),
    );
  },
);

server.tool(
  "list_workspace_snippets",
  "List workspace snippets (reusable rich-text clauses). Each row exposes the published blocks, is_locale_agnostic, and overrides_count. Archived snippets are excluded by default.",
  {
    q: z
      .string()
      .optional()
      .describe("Substring filter against key + title + description."),
    include_archived: z
      .boolean()
      .optional()
      .describe("When true, archived snippets are included in the result."),
    ...paginationInput,
  },
  async ({ q, include_archived, page, per_page }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (include_archived === true) params.set("exclude_archived", "0");
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));
    const qs = params.toString();
    return asToolResult(
      await callManagement("GET", `/workspace-snippets${qs ? `?${qs}` : ""}`),
    );
  },
);

server.tool(
  "list_locales",
  "List every locale code currently in use in the workspace — the union of the workspace's default_locale_code and every site's supported_locale_codes. Each entry flags whether it is the workspace default.",
  {},
  async () => asToolResult(await callManagement("GET", "/locales")),
);

server.tool(
  "list_documents",
  "List documents in the active workspace (id, slug, title, document_type code+label, locales). Use this to find the document_id you need for get_document_preview — e.g. the workspace's privacy-policy document. Paginated; supports filtering by document_type_code.",
  {
    document_type_code: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Filter to documents whose document_type.code matches exactly, e.g. 'privacy' or 'imprint'.",
      ),
    status: z
      .enum(["draft", "archived"])
      .optional()
      .describe("Filter by document status."),
    ...paginationInput,
  },
  async ({ document_type_code, status, page, per_page }) => {
    const params = new URLSearchParams();
    if (document_type_code) params.set("document_type_code", document_type_code);
    if (status) params.set("status", status);
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));
    const qs = params.toString();
    return asToolResult(
      await callManagement("GET", `/documents${qs ? `?${qs}` : ""}`),
    );
  },
);

server.tool(
  "get_document_preview",
  "Render a document as fully-resolved HTML for a (brand, locale, market, profile) target — the same Vorschau the customer-app's authoring tab shows. Use this AFTER creating variable/snippet overrides to verify they resolve correctly per (brand, locale): inspect `html` for cross-locale leakage and obvious placeholders, and `unresolved_variables` / `unresolved_snippets` for publish blockers. Omit a target axis to fall back to the workspace default for that axis.",
  {
    document_id: z
      .number()
      .int()
      .positive()
      .describe("Document row ID (see list_documents)."),
    brand_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Brand to resolve overrides against. Required to verify per-brand overrides created via create_variable_override / create_snippet_override.",
      ),
    locale: z
      .string()
      .max(32)
      .optional()
      .describe("BCP-47-like locale tag, e.g. de or en-GB."),
    market_code: z
      .string()
      .max(16)
      .optional()
      .describe("Market code (must already exist in the workspace)."),
    site_profile_code: z
      .string()
      .max(64)
      .optional()
      .describe("Site profile code (must already exist in the workspace)."),
  },
  async ({ document_id, brand_id, locale, market_code, site_profile_code }) => {
    const params = new URLSearchParams();
    if (brand_id !== undefined) params.set("brand_id", String(brand_id));
    if (locale) params.set("locale", locale);
    if (market_code) params.set("market_code", market_code);
    if (site_profile_code) params.set("site_profile_code", site_profile_code);
    const qs = params.toString();
    return asToolResult(
      await callManagement(
        "GET",
        `/documents/${document_id}/preview${qs ? `?${qs}` : ""}`,
      ),
    );
  },
);

server.tool(
  "list_document_unpublished_refs",
  "Pre-publish cascade discovery: for a document and the publication targets it would be published to, lists the snippets, variables, snippet-overrides and variable-overrides whose working draft differs from the last-published version. Use this to answer 'what drafts would the operator still need to publish if they wanted this document to ship its latest authored state?' Each row carries `latest_published_version_number` so the agent can phrase the diff (e.g. 'publish v3 → v4'). Read-only — never mutates state.",
  {
    document_id: z
      .number()
      .int()
      .positive()
      .describe("Document row ID (see list_documents)."),
    targets: z
      .array(
        z
          .object({
            site_id: z
              .number()
              .int()
              .positive()
              .describe("Target site to publish to (see list_sites)."),
            locale_code: z
              .string()
              .max(32)
              .optional()
              .describe(
                "BCP-47-like locale tag, e.g. de or en-GB. Omit to fall back to the site's default locale.",
              ),
            market_code: z
              .string()
              .max(16)
              .optional()
              .describe("Optional market code; must already exist in the workspace."),
            site_profile_code: z
              .string()
              .max(64)
              .optional()
              .describe("Optional site profile code; must already exist in the workspace."),
          })
          .strict(),
      )
      .min(1)
      .describe(
        "One row per (site, locale, market?, profile?) target the operator plans to publish to. Override discovery is filtered to overrides matching at least one of these tuples.",
      ),
  },
  async ({ document_id, targets }) =>
    asToolResult(
      await callManagement("POST", `/documents/${document_id}/unpublished-references`, {
        body: { targets },
      }),
    ),
);

// === Write tools ===========================================================

server.tool(
  "create_brand",
  "Create a new brand in the active workspace. Brands sit above sites — a single brand can own multiple sites. Returns the persisted brand.",
  {
    name: z.string().min(1).max(255).describe("Brand display name."),
    slug: z
      .string()
      .max(255)
      .optional()
      .describe("Optional URL-safe slug; the server generates one if omitted."),
    display_name: z
      .string()
      .max(255)
      .optional()
      .describe("Optional alternate display label."),
    notes: z
      .string()
      .max(5000)
      .optional()
      .describe("Free-text operator notes (max 5000 chars)."),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", "/brands", {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "create_site",
  "Create a new site for an existing brand. Returns the persisted site with embedded domains (empty until add_domain_to_site is called).",
  {
    brand_id: z
      .number()
      .int()
      .positive()
      .describe("ID of the brand this site belongs to."),
    name: z.string().min(1).max(255).describe("Site display name."),
    slug: z
      .string()
      .max(255)
      .optional()
      .describe(
        "Optional URL-safe slug; the server generates one if omitted. The slug is part of the public delivery URL — rename-sensitive.",
      ),
    display_name: z.string().max(255).optional(),
    notes: z.string().max(5000).optional(),
    default_locale_code: z
      .string()
      .max(16)
      .optional()
      .describe(
        "BCP-47-like default locale for this site. Defaults to the workspace default if omitted.",
      ),
    supported_locale_codes: z
      .array(z.string().max(16))
      .optional()
      .describe(
        "All locales this site publishes in. Include default_locale_code if you set both.",
      ),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", "/sites", {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "add_domain_to_site",
  "Attach a domain (hostname) to an existing site. Pass primary=true to make it the site's primary domain.",
  {
    site_id: z.number().int().positive(),
    hostname: z.string().min(1).max(255).describe("Bare hostname, e.g. acme.de"),
    primary: z
      .boolean()
      .optional()
      .describe("Mark this domain as primary; demotes any previous primary."),
    notes: z.string().max(5000).optional(),
    ...idempotencyInput,
  },
  async ({ site_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", `/sites/${site_id}/domains`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "attach_market_to_site",
  "Attach an existing market to a site. Idempotent at the domain layer — re-attaching is a no-op. Returns the updated site detail with the markets array populated.",
  {
    site_id: z.number().int().positive(),
    market_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ site_id, market_id, idempotency_key }) =>
    asToolResult(
      await callManagement("POST", `/sites/${site_id}/markets`, {
        body: { market_id },
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "create_variable_override",
  "Create a workspace-variable override scoped by (locale, optionally brand_id / market_id / site_profile_id). Locale is always required at the domain layer — the is_locale_agnostic flag on the parent affects publishing, not whether per-locale overrides may exist. Returns the persisted override.",
  {
    variable_id: z.number().int().positive(),
    value: z
      .string()
      .max(1024)
      .describe(
        "The overridden value. Plain string (max 1024 chars). Nested {{key}} tokens are NOT permitted.",
      ),
    locale: z
      .string()
      .min(1)
      .max(32)
      .describe("BCP-47-like locale tag, e.g. de or en-GB."),
    ...overrideAxes,
    ...idempotencyInput,
  },
  async ({ variable_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-variables/${variable_id}/overrides`,
        {
          body,
          idempotencyKey: idempotency_key,
        },
      ),
    ),
);

server.tool(
  "create_snippet_override",
  "Create a workspace-snippet override scoped by (locale, optionally brand_id / market_id / site_profile_id). If `blocks` is omitted, the server seeds the override's working_blocks from the structurally-closest parent. Pass blocks=[] to force an empty draft. Returns the persisted override.",
  {
    snippet_id: z.number().int().positive(),
    locale: z.string().min(1).max(32),
    ...overrideAxes,
    blocks: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        "Rich-text block list. Each block is an object with at least a `kind` and the kind-specific payload (e.g. {kind: 'paragraph', text: '…'}). Omit to seed from the closest parent.",
      ),
    ...idempotencyInput,
  },
  async ({ snippet_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-snippets/${snippet_id}/overrides`,
        {
          body,
          idempotencyKey: idempotency_key,
        },
      ),
    ),
);

// --- snippet override CRUD (beyond create) ----------------------------------

server.tool(
  "list_snippet_overrides",
  "List per-axis overrides for a given snippet. Returns the override row IDs you need before calling update_snippet_override / archive_snippet_override.",
  {
    snippet_id: z.number().int().positive(),
    include_archived: z
      .boolean()
      .optional()
      .describe("Include archived overrides. Defaults to true on this endpoint."),
    ...paginationInput,
  },
  async ({ snippet_id, include_archived, page, per_page }) => {
    const params = new URLSearchParams();
    if (include_archived !== undefined) {
      params.set("include_archived", include_archived ? "1" : "0");
    }
    if (page !== undefined) params.set("page", String(page));
    if (per_page !== undefined) params.set("per_page", String(per_page));
    const query = params.toString();
    return asToolResult(
      await callManagement(
        "GET",
        `/workspace-snippets/${snippet_id}/overrides${query ? `?${query}` : ""}`,
      ),
    );
  },
);

server.tool(
  "get_snippet_override",
  "Fetch a single snippet override by ID, including its working_blocks draft.",
  {
    snippet_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
  },
  async ({ snippet_id, override_id }) =>
    asToolResult(
      await callManagement(
        "GET",
        `/workspace-snippets/${snippet_id}/overrides/${override_id}`,
      ),
    ),
);

server.tool(
  "update_snippet_override",
  "Edit an existing snippet override's working_blocks draft. Send the full block list — the action replaces working_blocks, it does not patch individual blocks. Pass working_blocks=[] to clear the draft (the snippet then falls back to a less-specific override or the parent at render time).",
  {
    snippet_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
    working_blocks: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "Replacement rich-text block list. Same shape as create_snippet_override.blocks.",
      ),
    ...idempotencyInput,
  },
  async ({ snippet_id, override_id, working_blocks, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "PATCH",
        `/workspace-snippets/${snippet_id}/overrides/${override_id}`,
        {
          body: { working_blocks },
          idempotencyKey: idempotency_key,
        },
      ),
    ),
);

server.tool(
  "archive_snippet_override",
  "Archive a snippet override. Soft-delete: sets archived_at. The override stops resolving but the row stays so it can be restored. A body-less snippet keeps its last live override (the action rejects archiving the last sibling).",
  {
    snippet_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ snippet_id, override_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-snippets/${snippet_id}/overrides/${override_id}/archive`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "restore_snippet_override",
  "Restore a previously archived snippet override. Rejected with override.ambiguous if the restored row would tie with another live override on the same axis tuple — narrow with another axis (market / profile) and try again.",
  {
    snippet_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ snippet_id, override_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-snippets/${snippet_id}/overrides/${override_id}/restore`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

// --- variable override CRUD (beyond create) ---------------------------------

server.tool(
  "list_variable_overrides",
  "List per-axis overrides for a given variable. Returns the override row IDs you need before calling update_variable_override / delete_variable_override.",
  {
    variable_id: z.number().int().positive(),
    ...paginationInput,
  },
  async ({ variable_id, page, per_page }) => {
    const params = new URLSearchParams();
    if (page !== undefined) params.set("page", String(page));
    if (per_page !== undefined) params.set("per_page", String(per_page));
    const query = params.toString();
    return asToolResult(
      await callManagement(
        "GET",
        `/workspace-variables/${variable_id}/overrides${query ? `?${query}` : ""}`,
      ),
    );
  },
);

server.tool(
  "get_variable_override",
  "Fetch a single variable override by ID.",
  {
    variable_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
  },
  async ({ variable_id, override_id }) =>
    asToolResult(
      await callManagement(
        "GET",
        `/workspace-variables/${variable_id}/overrides/${override_id}`,
      ),
    ),
);

server.tool(
  "update_variable_override",
  "Edit an existing variable override's value. Plain string, max 1024 chars, no nested {{key}} tokens.",
  {
    variable_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
    value: z.string().max(1024),
    ...idempotencyInput,
  },
  async ({ variable_id, override_id, value, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "PATCH",
        `/workspace-variables/${variable_id}/overrides/${override_id}`,
        { body: { value }, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "delete_variable_override",
  "Hard-delete a variable override. Rejected with resource.conflict if this is the last override and the parent variable has no default value.",
  {
    variable_id: z.number().int().positive(),
    override_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ variable_id, override_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "DELETE",
        `/workspace-variables/${variable_id}/overrides/${override_id}`,
        { idempotencyKey: idempotency_key },
      ),
    ),
);

// --- workspace snippet CRUD --------------------------------------------------

server.tool(
  "get_workspace_snippet",
  "Fetch a workspace snippet by ID, including working_blocks and the last-published version.",
  { snippet_id: z.number().int().positive() },
  async ({ snippet_id }) =>
    asToolResult(
      await callManagement("GET", `/workspace-snippets/${snippet_id}`),
    ),
);

server.tool(
  "create_workspace_snippet",
  "Create a new workspace snippet. Requires the `content:write` token ability. Optional working_blocks seeds the draft; omit to start with an empty draft.",
  {
    key: z
      .string()
      .min(1)
      .max(64)
      .describe("Workspace-unique key, referenced from document blocks."),
    title: z.string().min(1).max(255),
    description: z.string().max(500).optional(),
    is_locale_agnostic: z.boolean().optional(),
    working_blocks: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Initial rich-text draft."),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", `/workspace-snippets`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "update_workspace_snippet",
  "Edit a workspace snippet's title, description, working_blocks draft, or is_locale_agnostic flag. Omitted fields are left untouched. Pass description=null to clear it. Requires `content:write`.",
  {
    snippet_id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(500).nullable().optional(),
    is_locale_agnostic: z.boolean().optional(),
    working_blocks: z.array(z.record(z.string(), z.unknown())).optional(),
    ...idempotencyInput,
  },
  async ({ snippet_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("PATCH", `/workspace-snippets/${snippet_id}`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "archive_workspace_snippet",
  "Archive a workspace snippet. Soft-delete: rejected with snippet_in_use (409) if any active document still references it. Requires `content:write`.",
  {
    snippet_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ snippet_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-snippets/${snippet_id}/archive`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "restore_workspace_snippet",
  "Restore a previously archived workspace snippet. Requires `content:write`.",
  {
    snippet_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ snippet_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/workspace-snippets/${snippet_id}/restore`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

// --- workspace variable CRUD ------------------------------------------------

server.tool(
  "get_workspace_variable",
  "Fetch a workspace variable by ID, including the live draft `value` and the last-published value.",
  { variable_id: z.number().int().positive() },
  async ({ variable_id }) =>
    asToolResult(
      await callManagement("GET", `/workspace-variables/${variable_id}`),
    ),
);

server.tool(
  "create_workspace_variable",
  "Create a new workspace variable. Requires `content:write`. `value` is the workspace default; if omitted, callers must supply at least one override later (the resolver refuses to render a variable that has no value anywhere).",
  {
    key: z
      .string()
      .min(1)
      .max(64)
      .describe("Workspace-unique key, referenced from blocks as `{{key}}`."),
    value: z.string().max(1024).optional(),
    description: z.string().max(255).optional(),
    is_locale_agnostic: z.boolean().optional(),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", `/workspace-variables`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "update_workspace_variable",
  "Edit a workspace variable's value, description, or is_locale_agnostic flag. Omitted fields are left untouched. Pass value=null to clear the default (only allowed when at least one override exists); pass description=null to clear the description. Requires `content:write`.",
  {
    variable_id: z.number().int().positive(),
    value: z.string().max(1024).nullable().optional(),
    description: z.string().max(255).nullable().optional(),
    is_locale_agnostic: z.boolean().optional(),
    ...idempotencyInput,
  },
  async ({ variable_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("PATCH", `/workspace-variables/${variable_id}`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "delete_workspace_variable",
  "Hard-delete a workspace variable. Rejected with variable_in_use (409) if any active document still references the `{{key}}`. Requires `content:write`.",
  {
    variable_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ variable_id, idempotency_key }) =>
    asToolResult(
      await callManagement("DELETE", `/workspace-variables/${variable_id}`, {
        idempotencyKey: idempotency_key,
      }),
    ),
);

// === Document type CRUD ====================================================

server.tool(
  "list_document_types",
  "List document types in the active workspace — the taxonomy a document attaches to (`privacy`, `imprint`, `terms`, …). Use this BEFORE create_document to find the `document_type_id` (or `document_type_code`) to pass. Active-only by default; pass status='inactive' or status='active' to filter explicitly.",
  {
    status: z
      .enum(["active", "inactive"])
      .optional()
      .describe("Filter to types in this lifecycle state."),
    q: z
      .string()
      .optional()
      .describe("Substring filter against code + label + description."),
    ...paginationInput,
  },
  async ({ status, q, page, per_page }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));
    const qs = params.toString();
    return asToolResult(
      await callManagement("GET", `/document-types${qs ? `?${qs}` : ""}`),
    );
  },
);

server.tool(
  "get_document_type",
  "Fetch a single document type by row ID, including its tags, classification, and metadata.",
  { document_type_id: z.number().int().positive() },
  async ({ document_type_id }) =>
    asToolResult(
      await callManagement("GET", `/document-types/${document_type_id}`),
    ),
);

server.tool(
  "create_document_type",
  "Create a new document type in the active workspace. Requires the `content:write` ability. The `code` is the stable machine identifier (slugified, must be unique per workspace) used by the public delivery URL and by version history; the `label` is the human display name. Use this only when the workspace does not yet have a baseline type for what you're authoring (e.g. fresh tenant). Idempotent across the (token, route, key) tuple when `idempotency_key` is supplied.",
  {
    code: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Workspace-unique slug, e.g. 'privacy', 'imprint', 'terms', 'cookie_policy'. Normalized to lowercase.",
      ),
    label: z
      .string()
      .max(255)
      .optional()
      .describe(
        "Display name. Defaults to the normalized code if omitted.",
      ),
    description: z.string().max(1000).optional(),
    active: z
      .boolean()
      .optional()
      .describe("Defaults to true. When false, the type is created in `inactive` state and cannot receive new documents until activated."),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", "/document-types", {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "update_document_type",
  "Edit a document type's label, description, tags, classification, or free-form metadata blob. The `code` is immutable. Omitted fields are left untouched; pass `description: null` or `tags: null` to clear. Requires `content:write`.",
  {
    document_type_id: z.number().int().positive(),
    label: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    tags: z
      .array(z.string().max(64))
      .nullable()
      .optional()
      .describe(
        "List of lowercase tag strings (a-z, 0-9, _ or -). Pass null to clear.",
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe(
        "Free-form object payload (no list-style arrays at the top level). Pass null to clear.",
      ),
    classification: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Stable classification code; rejected if not a known DocumentTypeClassification value.",
      ),
    ...idempotencyInput,
  },
  async ({ document_type_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement(
        "PATCH",
        `/document-types/${document_type_id}`,
        { body, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "activate_document_type",
  "Flip a document type from `inactive` back to `active` (idempotent). Rejected with resource.conflict if the row was soft-deleted — restore it via the customer-app first.",
  {
    document_type_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_type_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/document-types/${document_type_id}/activate`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "deactivate_document_type",
  "Flip a document type from `active` to `inactive` (idempotent). Existing documents linked to the type remain queryable; only new documents are blocked from selecting it.",
  {
    document_type_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_type_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/document-types/${document_type_id}/deactivate`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

// === Document CRUD =========================================================

server.tool(
  "get_document",
  "Fetch a single document by ID, including its full structured tree (sections with their ordered blocks). Use this after a series of section/block writes to inspect the persisted draft, or as the starting point for an edit.",
  { document_id: z.number().int().positive() },
  async ({ document_id }) =>
    asToolResult(await callManagement("GET", `/documents/${document_id}`)),
);

server.tool(
  "create_document",
  "Create a new base document in the active workspace. The action creates the row + lifecycle status only — sections + blocks are authored separately via upsert_document_section / upsert_document_block. Either `document_type_id` (preferred) or `document_type_code` is required. Slug is auto-derived from the title when omitted, kept unique per (workspace, type), and is immutable once persisted (rename = new document). Requires `content:write`.",
  {
    document_type_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Document type to attach this document to (see list_document_types). Pass either this or document_type_code.",
      ),
    document_type_code: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Resolve the type by its stable code (e.g. 'privacy'). Convenient when the agent only knows the code; the server resolves it to the workspace's `document_type_id`.",
      ),
    title: z.string().min(1).max(255).describe("Display title."),
    slug: z
      .string()
      .max(255)
      .optional()
      .describe(
        "URL-safe slug. The server normalizes from `title` if omitted and appends a numeric suffix on collision.",
      ),
    summary: z
      .string()
      .max(5000)
      .optional()
      .describe("Free-text operator summary."),
    client_id: z.number().int().positive().nullable().optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    product_id: z.number().int().positive().nullable().optional(),
    site_id: z.number().int().positive().nullable().optional(),
    supported_locale_codes: z
      .array(z.string().max(32))
      .optional()
      .describe(
        "BCP-47-like locale codes this document is authored in. Defaults to the linked site's locales (falling back to the workspace default). Must contain `default_locale_code` if both are sent.",
      ),
    default_locale_code: z
      .string()
      .max(32)
      .optional()
      .describe(
        "Default locale; falls back to the first entry of `supported_locale_codes`, then the linked site's default, then the workspace default.",
      ),
    ...idempotencyInput,
  },
  async ({ idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("POST", "/documents", {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "update_document",
  "Edit a document's title, summary, structural scope (client/brand/product/site), or document_type_id. The slug is intentionally NOT editable — rename = new document. Changing `document_type_id` is rejected with `document_type_publications_exist` if live publications under the current type still exist; pass `confirm_publication_url_break=true` to acknowledge that the public delivery URLs will be orphaned.",
  {
    document_id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    summary: z.string().max(5000).nullable().optional(),
    client_id: z.number().int().positive().nullable().optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    product_id: z.number().int().positive().nullable().optional(),
    site_id: z.number().int().positive().nullable().optional(),
    document_type_id: z.number().int().positive().optional(),
    confirm_publication_url_break: z.boolean().optional(),
    ...idempotencyInput,
  },
  async ({ document_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement("PATCH", `/documents/${document_id}`, {
        body,
        idempotencyKey: idempotency_key,
      }),
    ),
);

server.tool(
  "archive_document",
  "Archive a document (soft lifecycle freeze). Archived documents stop receiving content writes; sections/blocks remain queryable but the document_blocks/sections endpoints reject mutations. Idempotent.",
  {
    document_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/documents/${document_id}/archive`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "restore_document",
  "Restore an archived document back to `draft`. Idempotent for already-draft documents.",
  {
    document_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/documents/${document_id}/restore`,
        { body: {}, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "delete_document",
  "Hard-delete a document. Rejected with `document_in_use` (409) when any of: a publication (live or rolled-back), an active review request (pending / in_review), or a pending patch proposal (proposed / under_review / approved) references the document. Archive instead if you want to preserve those artefacts.",
  {
    document_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "DELETE",
        `/documents/${document_id}`,
        { idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "add_document_locale",
  "Add a translation locale to a document. The server deep-copies the default-locale text into the new locale's translation slot so the SPA opens a populated tab instead of an empty stub. Idempotent — re-adding an existing locale is a no-op.",
  {
    document_id: z.number().int().positive(),
    locale: z
      .string()
      .min(1)
      .max(32)
      .describe("BCP-47-like locale tag, e.g. en or en-GB."),
    ...idempotencyInput,
  },
  async ({ document_id, locale, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/documents/${document_id}/locales`,
        { body: { locale }, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "remove_document_locale",
  "Remove a translation locale from a document. The default locale cannot be removed — the server returns 422 + `code = cannot_remove_default_locale` for that case.",
  {
    document_id: z.number().int().positive(),
    locale: z.string().min(1).max(32),
    ...idempotencyInput,
  },
  async ({ document_id, locale, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "DELETE",
        `/documents/${document_id}/locales/${encodeURIComponent(locale)}`,
        { idempotencyKey: idempotency_key },
      ),
    ),
);

// === Document sections =====================================================

server.tool(
  "list_document_sections",
  "List the sections of a document, ordered by position. Each entry embeds its `blocks` array (also ordered by position) so a single call returns the structured tree the customer-app's editor renders.",
  { document_id: z.number().int().positive() },
  async ({ document_id }) =>
    asToolResult(
      await callManagement("GET", `/documents/${document_id}/sections`),
    ),
);

server.tool(
  "upsert_document_section",
  "Create-or-update a document section by stable `key`. The `key` is immutable once persisted because variant overrides reference it; the mutable fields on an existing section are `title` and `translations`. New sections are appended to the document's end (re-position via reorder_document_sections). Requires `content:write`.",
  {
    document_id: z.number().int().positive(),
    key: z
      .string()
      .min(2)
      .max(64)
      .describe(
        "Stable identifier (2–64 chars, must start with a letter, only a-z / 0-9 / underscore / hyphen).",
      ),
    title: z
      .string()
      .max(255)
      .nullable()
      .optional()
      .describe(
        "Default-locale section title (the document's `default_locale_code`). Pass null to clear an existing title.",
      ),
    translations: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Per-locale title overrides for the section. Shape: `{ [locale]: { title: string } }` or `{ [locale]: null }` to drop a locale entry. Locales must appear in the document's `supported_locale_codes` and MUST NOT equal `default_locale_code` (edit `title` for that). Partial-merge semantics: locales not present are left untouched. Omit the field entirely to leave existing translations as-is.",
      ),
    ...idempotencyInput,
  },
  async ({ document_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement(
        "PUT",
        `/documents/${document_id}/sections`,
        { body, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "delete_document_section",
  "Hard-delete a section and all blocks it contains. The server re-packs remaining section positions to stay contiguous.",
  {
    document_id: z.number().int().positive(),
    section_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_id, section_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "DELETE",
        `/documents/${document_id}/sections/${section_id}`,
        { idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "reorder_document_sections",
  "Reorder a document's sections deterministically. The input MUST list every section's `key` exactly once — partial orders are rejected. Returns `{status: 'ok'}` on success; a no-op call (current order matches input) is a no-op and does not emit an audit event.",
  {
    document_id: z.number().int().positive(),
    ordered_keys: z
      .array(z.string().min(1).max(255))
      .min(1)
      .describe(
        "Complete list of section keys in the desired order. Must cover every section exactly once.",
      ),
    ...idempotencyInput,
  },
  async ({ document_id, ordered_keys, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/documents/${document_id}/sections/reorder`,
        { body: { ordered_keys }, idempotencyKey: idempotency_key },
      ),
    ),
);

// === Document blocks =======================================================

server.tool(
  "list_document_blocks",
  "List the blocks of a specific section, ordered by position. Same data as `list_document_sections[i].blocks`, exposed separately for callers that already have a section id and don't need the full tree.",
  {
    document_id: z.number().int().positive(),
    section_id: z.number().int().positive(),
  },
  async ({ document_id, section_id }) =>
    asToolResult(
      await callManagement(
        "GET",
        `/documents/${document_id}/sections/${section_id}/blocks`,
      ),
    ),
);

server.tool(
  "upsert_document_block",
  "Create-or-update a document block by stable `key`. The `key` is unique per document — moving a block to a different section is allowed by passing the new section's id. `kind` controls payload validation; the supported kinds are: heading, paragraph, list, note, table, image, snippet_reference. Payload shapes are kind-specific (see below). Variable references like `{{key}}` inside text are validated against the workspace's variables. Snippet references must point to a published snippet. Requires `content:write`.",
  {
    document_id: z.number().int().positive(),
    section_id: z
      .number()
      .int()
      .positive()
      .describe("Target section id."),
    key: z
      .string()
      .min(2)
      .max(64)
      .describe(
        "Stable identifier (2–64 chars, must start with a letter, only a-z / 0-9 / underscore / hyphen). Unique per document.",
      ),
    kind: z
      .enum([
        "heading",
        "paragraph",
        "list",
        "note",
        "table",
        "image",
        "snippet_reference",
      ])
      .describe(
        "Block kind. Payload schema:\n" +
          "  heading            -> { text: string, level?: 1-6 (default 2), inlines?: list }\n" +
          "  paragraph          -> { text: string, inlines?: list }\n" +
          "  list               -> { items: list<string>, style?: 'bullet'|'ordered', item_inlines?: list }\n" +
          "  note               -> { text: string, severity?: 'info'|'warning' (default 'info'), inlines?: list }\n" +
          "  table              -> { rows: list<list<string>>, header?: bool, cell_inlines?: list, cell_attrs?: list }\n" +
          "  image              -> { src: absolute http(s) URL, alt?: string, title?: string }\n" +
          "  snippet_reference  -> { snippet_id: int (must point to a published workspace snippet) }",
      ),
    payload: z
      .record(z.string(), z.unknown())
      .describe(
        "Default-locale (document's `default_locale_code`) payload. Kind-specific schema (see the `kind` description). Unknown fields are rejected.",
      ),
    translations: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Per-locale text-fragment overrides for the block. Shape: `{ [locale]: <text-fragment> }` or `{ [locale]: null }` to drop a locale entry. Locales must appear in the document's `supported_locale_codes` and MUST NOT equal `default_locale_code`. Partial-merge semantics: locales not in the input are left untouched. Fragments carry ONLY text-bearing fields (structural fields like `level`, `style`, `severity`, `header` stay shared across locales):\n" +
          "  heading            -> { text: string, inlines?: list }\n" +
          "  paragraph          -> { text: string, inlines?: list }\n" +
          "  list               -> { items: list<string>, item_inlines?: list }\n" +
          "  note               -> { text: string, inlines?: list }\n" +
          "  table              -> { rows: list<list<string>>, cell_inlines?: list }\n" +
          "  image              -> { alt?: string, title?: string }\n" +
          "  snippet_reference  -> not supported (no translatable text). Changing `kind` clears any stored translations.",
      ),
    ...idempotencyInput,
  },
  async ({ document_id, section_id, idempotency_key, ...body }) =>
    asToolResult(
      await callManagement(
        "PUT",
        `/documents/${document_id}/sections/${section_id}/blocks`,
        { body, idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "delete_document_block",
  "Hard-delete a block. Remaining blocks in the same section are repositioned to stay contiguous.",
  {
    document_id: z.number().int().positive(),
    section_id: z.number().int().positive(),
    block_id: z.number().int().positive(),
    ...idempotencyInput,
  },
  async ({ document_id, section_id, block_id, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "DELETE",
        `/documents/${document_id}/sections/${section_id}/blocks/${block_id}`,
        { idempotencyKey: idempotency_key },
      ),
    ),
);

server.tool(
  "reorder_document_blocks",
  "Reorder a section's blocks deterministically. The input MUST list every block's `key` exactly once — partial orders are rejected. A no-op call (current order matches input) is silent.",
  {
    document_id: z.number().int().positive(),
    section_id: z.number().int().positive(),
    ordered_keys: z
      .array(z.string().min(1).max(255))
      .min(1)
      .describe(
        "Complete list of block keys in the desired order. Must cover every block in the section exactly once.",
      ),
    ...idempotencyInput,
  },
  async ({ document_id, section_id, ordered_keys, idempotency_key }) =>
    asToolResult(
      await callManagement(
        "POST",
        `/documents/${document_id}/sections/${section_id}/blocks/reorder`,
        { body: { ordered_keys }, idempotencyKey: idempotency_key },
      ),
    ),
);

// --- boot --------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Stderr-only; never expose details that could include the token.
  process.stderr.write(`termshelf-mcp-server failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
