import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const commonOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
};

await Promise.all([
  build({
    ...commonOptions,
    entryPoints: ["src/cli/index.ts"],
    outfile: "dist/cli.js",
  }),
  build({
    ...commonOptions,
    entryPoints: ["src/mcp/index.ts"],
    outfile: "dist/mcp.js",
  }),
]);
