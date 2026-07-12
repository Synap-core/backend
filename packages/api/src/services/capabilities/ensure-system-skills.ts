/**
 * ensureSystemSkills (W5) — seed the AI-teaching-substrate baseline skills as DB rows.
 *
 * Reads every baseline skill package (`skills/manifest.json` → `synap`, `synap-schema`,
 * `synap-ui`) off disk via the SAME loader `GET /skills/system` uses
 * (`loadSkillPackagesFromDisk`, see `hub-protocol/rest/skills.ts`) and upserts one
 * `kind='instruction'` row per topic `.md` file — pod-scoped, born `approved` (prompt-only,
 * no side effects), namespaced `system/<package>/<file-stem>` so user-authored skills can
 * never collide with it.
 *
 * Idempotent + drift-healing + non-fatal, modeled exactly on `ensureSynapCoreCapability`
 * (`ensure-synap-core.ts`): a content edit changes the row's `contentHash` → the next boot
 * re-projects body + teaching fields; an unchanged file is a no-op; a pre-bootstrap pod (no
 * owner yet) is skipped and retried next boot.
 *
 * WIRING: call once at pod startup, right after `ensureSynapCoreCapability()` — same
 * try/catch + log shape as its startup-hooks.ts neighbors.
 */

import crypto from "crypto";

import { createLogger } from "@synap-core/core";
import { db, and, eq, isNull, skills } from "@synap/database";
import { like } from "drizzle-orm";

import { resolvePodOwnerUserId } from "./pod-owner.js";
import {
  loadSkillPackagesFromDisk,
  type SkillPackage,
} from "../../routers/hub-protocol/rest/skills.js";
import {
  SYSTEM_SKILL_TEACHING,
  type SystemSkillTeaching,
} from "./system-skill-teaching.js";

const logger = createLogger({ module: "ensure-system-skills" });

/** namespaced slug for a package/file — the collision-proof system namespace. */
function systemSlug(pkg: string, fileStem: string): string {
  return `system/${pkg}/${fileStem.toLowerCase()}`;
}

function contentHash(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/** Extract the file's own title from its first `#`/`##` heading; falls back to the stem. */
function extractTitle(body: string, fallback: string): string {
  const match = body.match(/^#{1,2}\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

interface SeedProjection {
  slug: string;
  name: string;
  description: string;
  body: string;
  teachesTools: string[];
  skillGroup: string | null;
  alwaysOn: boolean;
  metadata: {
    system: true;
    package: string;
    file: string;
    contentHash: string;
    seededBy: "ensureSystemSkills";
  };
}

function projectFile(
  pkg: SkillPackage,
  fileStem: string,
  content: string,
  filePath: string
): SeedProjection {
  const teaching: SystemSkillTeaching | undefined =
    SYSTEM_SKILL_TEACHING[`${pkg.slug}/${fileStem}`];
  const hash = contentHash(content);
  const name = extractTitle(content, fileStem);
  return {
    slug: systemSlug(pkg.slug, fileStem),
    name,
    description: teaching?.summary ?? name,
    body: content,
    teachesTools: teaching?.teachesTools ?? [],
    skillGroup: teaching?.skillGroup ?? null,
    alwaysOn: teaching?.alwaysOn ?? false,
    metadata: {
      system: true,
      package: pkg.slug,
      file: filePath,
      contentHash: hash,
      seededBy: "ensureSystemSkills",
    },
  };
}

/**
 * Seed/heal the baseline instruction skills as pod-wide `skills` rows. Safe to call on
 * every boot. Non-fatal: any failure (or a pre-bootstrap pod, or no disk packages found —
 * e.g. running from a build output without the `skills/` tree) is logged and swallowed.
 */
export async function ensureSystemSkills(): Promise<void> {
  try {
    const packages = loadSkillPackagesFromDisk();
    if (!packages || packages.length === 0) {
      logger.debug(
        "No skill packages found on disk — skipping system-skill seed"
      );
      return;
    }

    const ownerUserId = await resolvePodOwnerUserId();
    if (!ownerUserId) {
      logger.info(
        "No pod owner yet (pre-bootstrap) — deferring system-skill seed to a later boot"
      );
      return;
    }

    // One batched read of every previously-seeded system row (namespace prefix), instead
    // of a query per file — mirrors the single convergence-guard read in ensure-synap-core.
    const existingRows = await db
      .select({
        id: skills.id,
        slug: skills.slug,
        metadata: skills.metadata,
      })
      .from(skills)
      .where(and(isNull(skills.workspaceId), like(skills.slug, "system/%")));
    const existingBySlug = new Map(
      existingRows.map((row) => [row.slug as string, row])
    );

    let seeded = 0;
    let healed = 0;
    let skipped = 0;

    for (const pkg of packages) {
      for (const file of pkg.files) {
        const fileStem = file.path.replace(/\.md$/, "");
        const projection = projectFile(pkg, fileStem, file.content, file.path);
        const existing = existingBySlug.get(projection.slug);

        if (!existing) {
          await db.insert(skills).values({
            userId: ownerUserId,
            workspaceId: null,
            slug: projection.slug,
            kind: "instruction",
            scope: "pod",
            status: "active",
            approved: true,
            name: projection.name,
            description: projection.description,
            body: projection.body,
            teachesTools: projection.teachesTools,
            skillGroup: projection.skillGroup,
            alwaysOn: projection.alwaysOn,
            metadata: projection.metadata,
          });
          seeded++;
          continue;
        }

        const existingMeta = (existing.metadata ?? {}) as Record<
          string,
          unknown
        >;
        if (existingMeta.system !== true) {
          logger.warn(
            { slug: projection.slug },
            "Slug collision with a non-system skill — skipping (never overwriting user content)"
          );
          skipped++;
          continue;
        }
        if (existingMeta.contentHash === projection.metadata.contentHash) {
          continue; // unchanged — no-op
        }

        await db
          .update(skills)
          .set({
            name: projection.name,
            description: projection.description,
            body: projection.body,
            teachesTools: projection.teachesTools,
            skillGroup: projection.skillGroup,
            alwaysOn: projection.alwaysOn,
            metadata: projection.metadata,
            updatedAt: new Date(),
          })
          .where(eq(skills.id, existing.id));
        healed++;
      }
    }

    if (seeded > 0 || healed > 0 || skipped > 0) {
      logger.info({ seeded, healed, skipped }, "System skills seed converged");
    } else {
      logger.debug("System skills already in sync — no-op");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to seed system skills on startup (non-fatal)");
  }
}
