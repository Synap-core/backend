/**
 * Replace tsc's re-export `dist/vendor/document-access.js` with the api's
 * document-access entry BUNDLED, so the deployed realtime needs only its own
 * prod dependencies (see src/vendor/document-access.ts for why).
 *
 * Fails the build if the output still reaches for `@synap/api`, or if it
 * imports a package realtime does not declare as a dependency — either would
 * crash the deployed server on its first room join.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const prodDeps = Object.keys(pkg.dependencies ?? {});
const outfile = join(root, "dist/vendor/document-access.js");

// Resolve the api entry the same way Node would from this package.
const require = createRequire(join(root, "package.json"));
const entry = require.resolve("@synap/api/document-access");

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  metafile: true,
  logLevel: "warning",
  // Every bare import stays external; the checks below prove each is a
  // realtime dependency.
  plugins: [
    {
      name: "externalize-packages",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});

const pkgName = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
const externals = new Set();
for (const input of Object.values(result.metafile.inputs)) {
  for (const imp of input.imports) if (imp.external) externals.add(pkgName(imp.path));
}
const bad = [...externals].filter(
  (name) => name === "@synap/api" || !prodDeps.includes(name)
);
if (bad.length > 0) {
  console.error(
    `[bundle-document-access] the bundle imports packages realtime does not ship: ${bad.join(", ")}`
  );
  process.exit(1);
}
console.log(
  `[bundle-document-access] ${outfile} (externals: ${[...externals].join(", ")})`
);
