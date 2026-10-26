/**
 * Replace tsc's re-exports `dist/vendor/<entry>.js` with the api's entries
 * BUNDLED, so the deployed realtime needs only its own prod dependencies (see
 * src/vendor/document-access.ts for why). One esbuild run per entry:
 *   - `document-access` — the document read/edit floor (Yjs rooms);
 *   - `access-door`     — THE access door (`@synap/api/access-door`).
 *
 * Fails the build if an output still reaches for `@synap/api`, or if it
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
const require = createRequire(join(root, "package.json"));
const pkgName = (spec) =>
  spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];

for (const name of ["document-access", "access-door"]) {
  const outfile = join(root, `dist/vendor/${name}.js`);
  // Resolve the api entry the same way Node would from this package.
  const entry = require.resolve(`@synap/api/${name}`);

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

  const externals = new Set();
  for (const input of Object.values(result.metafile.inputs)) {
    for (const imp of input.imports)
      if (imp.external) externals.add(pkgName(imp.path));
  }
  const bad = [...externals].filter(
    (dep) => dep === "@synap/api" || !prodDeps.includes(dep)
  );
  if (bad.length > 0) {
    console.error(
      `[bundle-document-access] ${name}: the bundle imports packages realtime does not ship: ${bad.join(", ")}`
    );
    process.exit(1);
  }
  console.log(
    `[bundle-document-access] ${outfile} (externals: ${[...externals].join(", ")})`
  );
}
