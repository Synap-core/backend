/**
 * Hub Protocol REST — skills
 */

import fs from "fs";
import path from "path";

import { createRoute, z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

export type SkillFile = { path: string; content: string };
export type SkillPackage = { slug: string; files: SkillFile[] };

/**
 * Read the deliverable skill slugs from skills/manifest.json (baseline +
 * workflow). The manifest is the single source of truth shared with the CLI
 * installer + sync-skills.sh. Falls back to the three baseline slugs if the
 * manifest is absent or malformed, so a missing file degrades gracefully.
 */
function readManifestSlugs(skillsDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(skillsDir, "manifest.json"), "utf-8");
    const m = JSON.parse(raw) as { baseline?: string[]; workflow?: string[] };
    const slugs = [...(m.baseline ?? []), ...(m.workflow ?? [])];
    if (slugs.length) return slugs;
  } catch {
    /* fall through to the baseline default */
  }
  return ["synap", "synap-schema", "synap-ui"];
}

/**
 * Exported so `ensureSystemSkills()` (the DB-seeding startup hook, see
 * `services/capabilities/ensure-system-skills.ts`) reuses this one disk loader
 * instead of duplicating the manifest/topic-file-discovery logic.
 */
export function loadSkillPackagesFromDisk(): SkillPackage[] | null {
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../../../skills"
    ),
  ];
  const skillsDir = candidates.find((d) => fs.existsSync(d));
  if (!skillsDir) return null;

  // Which packages to serve: read the shared skills manifest (skills/manifest.json,
  // the single source of truth shared with the CLI installer + sync-skills.sh).
  // baseline = always-on, workflow = intent-triggered; both are delivered to
  // agents. Topic files are the source of truth and the monolithic SKILL.md is a
  // generated build artifact (see skills/build.mjs). Enumerate every `*.md` in
  // each package dynamically so adding a topic file does not require editing a
  // list. SKILL.md is always served first (the `?scope=core` payload); the
  // remaining topic files follow, sorted.
  const SKILL_SLUGS = readManifestSlugs(skillsDir);

  const packages: SkillPackage[] = [];
  for (const slug of SKILL_SLUGS) {
    const pkgDir = path.join(skillsDir, slug);
    if (!fs.existsSync(pkgDir)) continue;

    let mdFiles: string[];
    try {
      mdFiles = fs
        .readdirSync(pkgDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    // SKILL.md first (the assembled monolith / core scope), then the rest.
    // Exclude README.md (a packaging/marketing file, not a skill topic — matches
    // the IS sync-baseline-skills EXCLUDE set so both paths agree what a topic is).
    mdFiles = mdFiles.filter((f) => f !== "SKILL.md" && f !== "README.md");
    if (fs.existsSync(path.join(pkgDir, "SKILL.md"))) {
      mdFiles.unshift("SKILL.md");
    }

    const loaded: SkillFile[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(pkgDir, file);
      try {
        loaded.push({
          path: file,
          content: fs.readFileSync(filePath, "utf-8"),
        });
      } catch {
        /* skip unreadable */
      }
    }
    if (loaded.length) packages.push({ slug, files: loaded });
  }
  return packages.length ? packages : null;
}

// Loaded once at startup — synchronous read, cheap. `undefined` = not yet
// attempted; `null` = attempted and skills/ is missing on disk — a broken
// deployment (the image didn't COPY skills/), not a degraded one. There is
// deliberately no inline fallback content here anymore: serving stale
// hand-copied teaching text silently is worse than the route failing loudly.
let _cachedSkillPackages: SkillPackage[] | null | undefined;

function getSkillPackages(): SkillPackage[] | null {
  if (_cachedSkillPackages === undefined) {
    _cachedSkillPackages = loadSkillPackagesFromDisk();
  }
  return _cachedSkillPackages;
}

const SystemSkillFileSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .openapi("SystemSkillFile");

const SystemSkillPackageSchema = z
  .object({
    slug: z.string(),
    files: z.array(SystemSkillFileSchema),
  })
  .openapi("SystemSkillPackage");

// ── Register function ─────────────────────────────────────────────────────────

export function registerSkillsRoutes(app: HubHono): void {
  // ── GET /skills/system — STATIC, must come before /skills/:id ─────────────
  const getSystemSkillsRoute = createRoute({
    method: "get",
    path: "/skills/system",
    tags: ["Skills"],
    summary: "List system skill packages",
    description:
      "Returns static SKILL.md documentation for the built-in skill packages " +
      "listed in skills/manifest.json (baseline + workflow). Called by " +
      "ensureEveSkillsLayout() to populate ~/.eve/skills/ for Claude Code and " +
      "other text-based agents. Requires hub-protocol.read scope.",
    responses: {
      200: {
        description: "Array of skill packages with file contents",
        content: {
          "application/json": {
            schema: z.array(SystemSkillPackageSchema),
          },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description:
          "skills/ directory missing on disk — broken deployment (image didn't COPY skills/)",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getSystemSkillsRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    // ?scope=core  → SKILL.md only per package (minimal, ~300 lines total)
    // ?scope=full  → all files (default, backward compat)
    // ?sections=synap:capture,synap-ui:view-types → specific files only
    const scope = c.req.query("scope");
    const sectionsParam = c.req.query("sections");
    const allPackages = getSkillPackages();

    if (!allPackages) {
      logger.error(
        "GET /skills/system: skills/ directory not found on disk (checked cwd/skills " +
          "and the repo-root-relative path). This deployment is missing skills/manifest.json " +
          "+ package dirs — the Docker image must COPY skills/ into the runtime container. " +
          "Failing loudly rather than serving stale fallback documentation."
      );
      return c.json(
        {
          error:
            "System skill packages unavailable: skills/ directory not found on this " +
            "deployment. The Docker image must COPY skills/ into the runtime container.",
        },
        503
      );
    }

    if (sectionsParam) {
      // Parse "pkg:file,pkg:file" → filter to requested files
      const requested = sectionsParam.split(",").map((s) => s.trim());
      const filtered = allPackages
        .map((pkg) => ({
          ...pkg,
          files: pkg.files.filter(
            (f) =>
              requested.includes(
                `${pkg.slug}:${f.path.replace(/\.md$/, "")}`
              ) || requested.includes(`${pkg.slug}:${f.path}`)
          ),
        }))
        .filter((pkg) => pkg.files.length > 0);
      return c.json(filtered, 200);
    }

    if (scope === "core") {
      // Return only SKILL.md from each package
      const corePackages = allPackages
        .map((pkg) => ({
          ...pkg,
          files: pkg.files.filter((f) => f.path === "SKILL.md"),
        }))
        .filter((pkg) => pkg.files.length > 0);
      return c.json(corePackages, 200);
    }

    return c.json(allPackages, 200);
  });

  // NOTE: the legacy camelCase `/skills/getSkills`, `/skills/getSkill`, and
  // `POST /skills/createSkill` routes were removed in WAVE 4. The executable
  // `skills`-table operations now live under `/agent-skills/executable*` (see
  // agent-skills.ts). `/skills/system` above stays — it is the on-disk baseline
  // skill-package distribution endpoint that external/Claude-Code agents use.
}
