/**
 * The LIFECYCLES of the core (system-seeded) kinds — work model L1, 0319.
 *
 * The seeder (`ensure-system-profiles.ts`) creates these kinds and their
 * status selects with bare-string options; this pass gives each its ONE
 * lifecycle: option categories on the def (`constraints.enumOptions`, through
 * the one mapper) and the link flag (`declareLifecycle`, which also fills the
 * columns of existing rows from the read projection).
 *
 * Only knowledge-work kinds a person or an agent MOVES through a life are
 * declared. Machine-run statuses (report generation, devplane deploy / run /
 * cron, tool requests) are runtime bookkeeping, not a lifecycle, and stay plain
 * selects. Template kinds (deal `commercialStage`, lead `leadStage`) are
 * declared by their catalog templates, never here.
 *
 * Categories are a principled default (2026-10-11), overridable by editing
 * this table: a closing that achieved its purpose is `done`, one that ended
 * without it is `lost`.
 *
 * CONVERGENCE (backend rule: a marker may only assert what the comparator
 * checked): there is no stored marker. Each pass compares the def's stored
 * `enumOptions` for exactly the keys this table declares and rewrites only
 * when they differ; option values the pod added stay (non-destructive union).
 */
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { profiles, ProfileScope } from "../schema/profiles.js";
import { profileProperties } from "../schema/profile-properties.js";
import { propertyDefs } from "../schema/property-defs.js";
import {
  buildStoredConstraints,
  normalizeEnumOptions,
  readStoredEnumOptions,
} from "./property-enum.js";
import type { LifecycleOption } from "./lifecycle-model.js";
import { declareLifecycle } from "../services/lifecycle/declare-lifecycle.js";

type Db = PostgresJsDatabase<typeof schema>;

export const SYSTEM_LIFECYCLES: ReadonlyArray<{
  profileSlug: string;
  propertySlug: string;
  options: LifecycleOption[];
}> = [
  {
    profileSlug: "task",
    propertySlug: "status",
    options: [
      { key: "todo", category: "open" },
      { key: "in-progress", category: "active" },
      { key: "done", category: "done" },
      { key: "cancelled", category: "lost" },
    ],
  },
  {
    profileSlug: "decision",
    propertySlug: "decisionStatus",
    options: [
      { key: "proposed", category: "open" },
      { key: "accepted", category: "done" },
      { key: "superseded", category: "lost" },
      { key: "rejected", category: "lost" },
    ],
  },
  {
    profileSlug: "question",
    propertySlug: "questionStatus",
    options: [
      { key: "open", category: "open" },
      { key: "exploring", category: "active" },
      { key: "answered", category: "done" },
      { key: "abandoned", category: "lost" },
    ],
  },
  {
    profileSlug: "research",
    propertySlug: "researchStatus",
    options: [
      { key: "ongoing", category: "active" },
      { key: "concluded", category: "done" },
      { key: "abandoned", category: "lost" },
    ],
  },
];

export interface EnsureSystemLifecyclesResult {
  declared: string[];
  optionsUpdated: string[];
  refused: Array<{ profileSlug: string; reason: string }>;
}

export async function ensureSystemLifecycles(
  db: Db
): Promise<EnsureSystemLifecyclesResult> {
  const out: EnsureSystemLifecyclesResult = {
    declared: [],
    optionsUpdated: [],
    refused: [],
  };
  for (const decl of SYSTEM_LIFECYCLES) {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          eq(profiles.slug, decl.profileSlug),
          eq(profiles.scope, ProfileScope.SYSTEM),
          eq(profiles.isActive, true)
        )
      )
      .limit(1);
    if (!profile) {
      out.refused.push({
        profileSlug: decl.profileSlug,
        reason: "no system profile",
      });
      continue;
    }
    const [def] = await db
      .select({
        id: propertyDefs.id,
        constraints: propertyDefs.constraints,
        uiHints: propertyDefs.uiHints,
      })
      .from(profileProperties)
      .innerJoin(
        propertyDefs,
        eq(propertyDefs.id, profileProperties.propertyDefId)
      )
      .where(
        and(
          eq(profileProperties.profileId, profile.id),
          eq(propertyDefs.slug, decl.propertySlug)
        )
      )
      .limit(1);
    if (!def) {
      out.refused.push({
        profileSlug: decl.profileSlug,
        reason: `"${decl.propertySlug}" is not linked`,
      });
      continue;
    }

    // Converge the option objects: the declared ones first (exactly as this
    // table says), then any value the pod added, kept as stored.
    const stored = (def.constraints ?? {}) as Record<string, unknown>;
    const live =
      readStoredEnumOptions({
        constraints: stored,
        uiHints: def.uiHints as Record<string, unknown> | null,
      }) ?? [];
    const merged = [
      ...decl.options,
      ...live.filter((o) => !decl.options.some((d) => d.key === o.key)),
    ];
    const current = normalizeEnumOptions(stored.enumOptions) ?? null;
    if (
      JSON.stringify(normalizeEnumOptions(merged)) !== JSON.stringify(current)
    ) {
      await db
        .update(propertyDefs)
        .set({
          constraints: buildStoredConstraints({
            constraints: stored,
            enumOptions: merged,
          }),
          updatedAt: new Date(),
        })
        .where(eq(propertyDefs.id, def.id));
      out.optionsUpdated.push(decl.profileSlug);
    }

    const r = await declareLifecycle(db, {
      profileId: profile.id,
      propertySlug: decl.propertySlug,
    });
    if (r.status === "refused") {
      out.refused.push({ profileSlug: decl.profileSlug, reason: r.reason });
    } else if (r.status === "declared") {
      out.declared.push(decl.profileSlug);
    }
  }
  return out;
}
