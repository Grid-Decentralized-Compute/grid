// Bundles the server into one file, dist/grid-mcp.mjs, that runs with plain `node` from anywhere:
// MCP clients start it by path, outside this repository.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/grid-mcp.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __gridRequire } from 'node:module'; const require = __gridRequire(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "info",
});
