#!/usr/bin/env node
/**
 * Bump the plugin version across every file that carries one.
 *
 * Called by .github/workflows/release.yml between "Resolve next version"
 * and "Build bundled MCP server". The release commit pins all three to
 * the same value, so the customer-app, the bundled MCP server, and the
 * MCP handshake all report the same string.
 *
 * Files touched:
 *   - .claude-plugin/plugin.json         (`version` — the plugin version,
 *                                         the only one users see in
 *                                         Claude Code's plugin list)
 *   - mcp-server/package.json            (`version` — kept in lock-step
 *                                         even though the package is
 *                                         private and never published
 *                                         to npm)
 *   - mcp-server/index.mjs               (the `new McpServer({ version })`
 *                                         literal — reported in the MCP
 *                                         initialize handshake)
 *
 * Usage:
 *   node scripts/bump-version.mjs 1.2.3
 *
 * Exits non-zero with a clear message on:
 *   - missing or malformed version arg
 *   - any target file missing the expected version field
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  process.stderr.write(
    `Usage: node scripts/bump-version.mjs <X.Y.Z>\n` +
      `Got: ${JSON.stringify(process.argv[2])}\n`,
  );
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bumpJson(relativePath) {
  const abs = path.join(repoRoot, relativePath);
  const raw = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(raw);
  if (typeof json.version !== "string") {
    process.stderr.write(`Expected ${relativePath} to carry a string \"version\" field.\n`);
    process.exit(3);
  }
  json.version = next;
  // Match the JSON style produced by `npm version` and the existing
  // workflow snippet: 2-space indent, trailing newline.
  fs.writeFileSync(abs, JSON.stringify(json, null, 2) + "\n");
}

function bumpMcpServerVersionLiteral() {
  const rel = "mcp-server/index.mjs";
  const abs = path.join(repoRoot, rel);
  const src = fs.readFileSync(abs, "utf8");
  // Anchor on `new McpServer({ ... version: "X.Y.Z" ... })` so we only
  // touch the handshake literal, never a string that happens to look
  // like a version number in some unrelated context.
  const re = /(new McpServer\(\{[\s\S]*?version:\s*")([^"]+)(")/;
  if (!re.test(src)) {
    process.stderr.write(`Did not find a 'new McpServer({ … version: "…" })' literal in ${rel}.\n`);
    process.exit(4);
  }
  const next_src = src.replace(re, (_, before, _old, after) => `${before}${next}${after}`);
  fs.writeFileSync(abs, next_src);
}

bumpJson(".claude-plugin/plugin.json");
bumpJson("mcp-server/package.json");
bumpMcpServerVersionLiteral();

process.stdout.write(`Bumped plugin + mcp-server to ${next}.\n`);
