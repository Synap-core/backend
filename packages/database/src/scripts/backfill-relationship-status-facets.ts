/**
 * Backfill — person/company `properties.relationshipStatus` → facet-roles.
 *
 * Legacy CRM imports (The Arch / The Signal) stamped a free `relationshipStatus`
 * string onto person and company entities. The ratified Kind+Facets model
 * expresses those relationships as ROLE FACETS on the shared entity, not as a
 * bare property. This script materializes each status as the canonical facet:
 *
 *   partner   → attach `partner`
 *   client    → attach `client`
 *   lead      → attach `lead`
 *   prospect  → attach `lead`  + { leadStage: "prospect" } overlay
 *   former    → attach `churned` (if that role exists) — else `client` + { clientStatus: "former" }
 *   idle      → no facet (deliberately)
 *
 * ONE DOOR: every write goes through `FacetRepository.attach()` — never a raw
 * write to the entity_facets table. Role profiles are resolved by SLUG at runtime
 * (`lead` / `churned` are being added in foundation.yaml by a parallel change),
 * so nothing is hardcoded to an id.
 *
 * Idempotent: an already-attached role is skipped (and `attach()` itself returns
 * the existing row on the unique key), so the script is safe to re-run.
 *
 * Facets are attached POD-WIDE (workspace_id = NULL) so the role is visible
 * across every lens the entity appears in — matching the cross-lens intent of
 * the shared ecosystem roles.
 *
 * Run (against the pod your DATABASE_URL points at):
 *   tsx packages/database/src/scripts/backfill-relationship-status-facets.ts          # dry run (default)
 *   tsx packages/database/src/scripts/backfill-relationship-status-facets.ts --apply  # writes for real
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - executed by tsx, not compiled
import { getDb, sql } from "../client-pg.js";
import { EventRepository } from "../repositories/event-repository.js";
import { FacetRepository } from "../repositories/facet-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = !apply;

console.log("📦 Backfill: relationshipStatus → facet-roles\n");
console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "APPLY"}\n`);

/**
 * Map a raw relationshipStatus value to the facet(s) to attach.
 * Returns [] for values that should NOT produce a facet (e.g. `idle`).
 * Slugs are resolved to profiles at runtime; `former` prefers `churned` and
 * falls back to `client` + a status overlay when `churned` is not defined.
 */
function planForStatus(
  status: string,
  churnedExists: boolean
): Array<{ slug: string; properties?: Record<string, unknown> }> {
  switch (status.trim().toLowerCase()) {
    case "partner":
      return [{ slug: "partner" }];
    case "client":
      return [{ slug: "client" }];
    case "lead":
      return [{ slug: "lead" }];
    case "prospect":
      return [{ slug: "lead", properties: { leadStage: "prospect" } }];
    case "former":
      return churnedExists
        ? [{ slug: "churned" }]
        : [{ slug: "client", properties: { clientStatus: "former" } }];
    case "idle":
      return [];
    default:
      return [];
  }
}

interface EntityRow {
  id: string;
  type: string;
  user_id: string;
  workspace_id: string | null;
  relationship_status: string | null;
}

async function main(): Promise<void> {
  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const facetRepo = new FacetRepository(db, eventRepo);
  const profileRepo = new ProfileRepository(db);

  // Does the `churned` role exist yet (parallel foundation.yaml change)?
  const churnedExists =
    (await profileRepo.findActiveBySlugAnyScope("churned")).length > 0;

  // person / company entities carrying a non-empty relationshipStatus.
  const rows = (await sql`
    SELECT id, type, user_id, workspace_id,
           properties->>'relationshipStatus' AS relationship_status
    FROM entities
    WHERE deleted_at IS NULL
      AND type IN ('person', 'company')
      AND properties->>'relationshipStatus' IS NOT NULL
      AND properties->>'relationshipStatus' <> ''
  `) as unknown as EntityRow[];

  let planned = 0;
  let attached = 0;
  let skippedExisting = 0;
  let skippedNoFacet = 0;
  let failed = 0;

  for (const entity of rows) {
    const status = entity.relationship_status;
    if (!status) continue;
    const plan = planForStatus(status, churnedExists);
    if (plan.length === 0) {
      skippedNoFacet++;
      continue;
    }

    for (const item of plan) {
      // Resolve the role profile by slug (pod-wide) so we can (a) skip if the
      // facet is already attached and (b) fail loudly if the role is missing.
      const roleProfile = await profileRepo.findActiveBySlugAnyScope(item.slug);
      const role = roleProfile.find((p) => p.profileKind === "role");
      if (!role) {
        console.warn(
          `  ⚠️  ${entity.type} ${entity.id}: role '${item.slug}' not found (status=${status}) — skipped`
        );
        failed++;
        continue;
      }

      // Idempotency pre-check: already attached (any live facet for this
      // entity+profile)? attach() is also idempotent on the unique key, but the
      // pre-check keeps the run quiet and reportable.
      const existing = await sql`
        SELECT id FROM entity_facets
        WHERE entity_id = ${entity.id}
          AND profile_id = ${role.id}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (existing.length > 0) {
        skippedExisting++;
        continue;
      }

      planned++;
      console.log(
        `  ${dryRun ? "🔍" : "✅"} ${entity.type} ${entity.id}: attach '${item.slug}'${
          item.properties ? ` ${JSON.stringify(item.properties)}` : ""
        }  (status=${status})`
      );

      if (apply) {
        try {
          await facetRepo.attach(
            {
              entityId: entity.id,
              profileSlug: item.slug,
              userId: entity.user_id,
              // Pod-wide role — visible across every lens the entity appears in.
              workspaceId: null,
              properties: item.properties,
              createdByKind: "system",
            },
            entity.user_id
          );
          attached++;
        } catch (err) {
          console.error(
            `  ❌ ${entity.type} ${entity.id}: attach '${item.slug}' failed:`,
            err instanceof Error ? err.message : err
          );
          failed++;
        }
      }
    }
  }

  console.log(
    `\nEntities scanned: ${rows.length}  Planned: ${planned}  Attached: ${attached}  ` +
      `Already-attached: ${skippedExisting}  No-facet (idle/unknown): ${skippedNoFacet}  Failed: ${failed}`
  );
  if (dryRun) {
    console.log(
      "\n🔍 Dry run complete — nothing was written. Re-run with --apply to commit."
    );
  }
}

main()
  .catch((err) => {
    console.error("❌ Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
