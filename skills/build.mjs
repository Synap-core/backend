#!/usr/bin/env node
/**
 * Assemble each skill package's monolithic SKILL.md from its topic source files.
 *
 * SOURCE OF TRUTH = the fine-grained topic `.md` files + `_skill.yaml` (frontmatter)
 * + `_order.txt` (assembly order). The monolithic `SKILL.md` is a GENERATED build
 * artifact (gitignored) consumed by external agents via the CLI tarball and
 * `/skills/system` (?scope=core).
 *
 * For each package directory that contains both `_skill.yaml` and `_order.txt`:
 *   SKILL.md = "---\n" + frontmatter + "---\n\n" + topics.join("\n\n---\n\n") + "\n"
 *
 * Idempotent: running twice produces byte-identical output.
 *
 * Usage:  node skills/build.mjs            (from synap-backend root)
 *         node skills/build.mjs <skillsDir>
 */
import fs from "node:fs";
import path from "node:path";

const SKILLS_DIR = path.resolve(
  process.argv[2] || path.dirname(new URL(import.meta.url).pathname)
);

function assemblePackage(pkgDir) {
  const orderPath = path.join(pkgDir, "_order.txt");
  const yamlPath = path.join(pkgDir, "_skill.yaml");
  if (!fs.existsSync(orderPath) || !fs.existsSync(yamlPath)) return null;

  const frontmatter =
    fs.readFileSync(yamlPath, "utf8").replace(/\s*$/, "") + "\n";
  const order = fs
    .readFileSync(orderPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const topics = order.map((file) => {
    const p = path.join(pkgDir, file);
    if (!fs.existsSync(p)) {
      throw new Error(
        `build: ${pkgDir}: _order.txt references missing topic "${file}"`
      );
    }
    // normalize: strip trailing whitespace so the joiner controls spacing
    return fs.readFileSync(p, "utf8").replace(/\s*$/, "");
  });

  const assembled =
    "---\n" + frontmatter + "---\n\n" + topics.join("\n\n---\n\n") + "\n";

  fs.writeFileSync(path.join(pkgDir, "SKILL.md"), assembled);
  return {
    slug: path.basename(pkgDir),
    topics: order.length,
    bytes: assembled.length,
  };
}

const built = [];
for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const result = assemblePackage(path.join(SKILLS_DIR, entry.name));
  if (result) built.push(result);
}

if (built.length === 0) {
  console.error(`build: no assemblable packages found in ${SKILLS_DIR}`);
  process.exit(1);
}
for (const b of built) {
  console.log(
    `  built ${b.slug}/SKILL.md (${b.topics} topics, ${b.bytes} bytes)`
  );
}
console.log(`build: assembled ${built.length} SKILL.md`);
