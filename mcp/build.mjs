// Bundles the server and the command line into one file each, dist/grid-mcp.mjs and dist/grid-cli.mjs,
// that run with plain `node` from anywhere: MCP clients start the server by path, outside this
// repository, and the published package ships only these two files.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

for (const [entry, outfile] of [
  ["src/index.ts", "dist/grid-mcp.mjs"],
  ["src/cli.ts", "dist/grid-cli.mjs"],
]) {
  await build({
    entryPoints: [entry],
    outfile,
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
  // Runnable as ./dist/grid-cli.mjs on Linux and macOS; npm sets the same bit when it links a bin.
  chmodSync(outfile, 0o755);
}
