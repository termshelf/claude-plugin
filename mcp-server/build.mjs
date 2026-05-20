import { build } from "esbuild";

await build({
  entryPoints: ["index.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/index.mjs",
  legalComments: "none",
  banner: {
    js: [
      "import { createRequire as topLevelCreateRequire } from 'node:module';",
      "const require = topLevelCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
