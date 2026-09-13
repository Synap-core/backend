/**
 * SCHEMA CONTRACT — does the pod's system-profile schema still match the seed?
 *
 * The system seeder's link pass is ADDITIVE ONLY, so a link the seed stopped
 * declaring stays on every pod that ran the older seed, and a workspace-scoped
 * TWIN of a system kind silently narrows what an agent sees of it. Both made a
 * real client's agent unable to write. This section makes them VISIBLE; it
 * retires nothing (retirement is `RETIRED_PROFILE_PROPERTIES`, run at boot).
 *
 * "What the seed declares" is DERIVED from `SYSTEM_PROFILE_PROPERTY_LINKS`, the
 * seeder's own exported table — never a second list here. Retirement matching
 * reuses the seeder's `planRetirementUnlink`, so this report and the boot pass
 * cannot disagree about which link an entry targets.
 *
 * TWINS are ANY slug held by two or more active visible profile rows, whatever
 * their scopes — system+workspace (`knowledge`), shared+workspace (`partner`),
 * workspace+workspace (`project`). Anchoring on SYSTEM rows would miss the last
 * two shapes, both live. RESERVED rows come from `isReservedProfileSlug`, the
 * same door the profile write paths assert on, so they are visible before that
 * floor is tightened.
 */

import {
  db,
  and,
  eq,
  or,
  inArray,
  isReservedProfileSlug,
  profiles,
  profileProperties,
  propertyDefs,
  ProfileScope,
  RETIRED_PROFILE_PROPERTIES,
  SYSTEM_PROFILE_PROPERTY_LINKS,
  planRetirementUnlink,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import type { HealthSection } from "./types.js";

/** Rows reported in `detail` per list (the totals are always exact). */
const MAX_REPORTED = 50;

/** One profile→property link on a SYSTEM profile, with its def's scope. */
export interface SystemLinkRow {
  profileId: string;
  profileSlug: string;
  propertyDefId: string;
  defSlug: string;
  /** NULL = base/global def; set = a workspace overlay def. */
  defWorkspaceId: string | null;
}

/** One active profile row the caller can see. */
export interface ActiveProfileRow {
  profileId: string;
  slug: string;
  scope: string;
  workspaceId: string | null;
}

/** A slug held by two or more active rows. */
export interface TwinGroup {
  slug: string;
  rows: ActiveProfileRow[];
}

/**
 * - `pending`   a link on the profile still folds to the entry — the boot pass
 *               has not removed it (not yet run on this build, or it failed).
 * - `ambiguous` more than one link folds to it — the boot pass refuses.
 * - `inert`     no link folds to it. Either already converged or never
 *               present; the schema cannot tell those apart.
 * - `profile_absent` no active system profile carries the entry's slug.
 */
export type RetirementState =
  "pending" | "ambiguous" | "inert" | "profile_absent";

export interface SchemaContractSignal {
  undeclaredLinks: Array<{ profileSlug: string; propertySlug: string }>;
  twins: TwinGroup[];
  /** Active rows on a slug `isReservedProfileSlug` refuses. */
  reservedRows: ActiveProfileRow[];
  retirements: Array<{
    profileSlug: string;
    propertySlug: string;
    state: RetirementState;
    linkedSlugs: string[];
  }>;
}

type SeedLinks = ReadonlyArray<{
  profileSlug: string;
  propertySlugs: ReadonlyArray<{ slug: string }>;
}>;
type RetiredEntries = ReadonlyArray<{
  profileSlug: string;
  propertySlug: string;
}>;

/** PURE: classify the raw rows. DB-free — the unit-tested heart of the section. */
export function classifySchemaContract(input: {
  activeProfiles: readonly ActiveProfileRow[];
  systemLinks: readonly SystemLinkRow[];
  seedLinks?: SeedLinks;
  retired?: RetiredEntries;
}): SchemaContractSignal {
  const seedLinks = input.seedLinks ?? SYSTEM_PROFILE_PROPERTY_LINKS;
  const retired = input.retired ?? RETIRED_PROFILE_PROPERTIES;

  const declared = new Map<string, Set<string>>();
  for (const entry of seedLinks) {
    const set = declared.get(entry.profileSlug) ?? new Set<string>();
    for (const prop of entry.propertySlugs) set.add(prop.slug);
    declared.set(entry.profileSlug, set);
  }

  // Base-scoped only: a workspace overlay def (e.g. Builder's `task-status`) is
  // a legitimate per-workspace extension, not a claim the seed should own.
  const undeclaredLinks = input.systemLinks
    .filter((l) => l.defWorkspaceId === null)
    .filter((l) => !declared.get(l.profileSlug)?.has(l.defSlug))
    .map((l) => ({ profileSlug: l.profileSlug, propertySlug: l.defSlug }))
    .sort(
      (a, b) =>
        a.profileSlug.localeCompare(b.profileSlug) ||
        a.propertySlug.localeCompare(b.propertySlug)
    );

  const present = new Set(
    input.activeProfiles
      .filter((p) => p.scope === ProfileScope.SYSTEM)
      .map((p) => p.slug)
  );

  const bySlug = new Map<string, ActiveProfileRow[]>();
  for (const row of input.activeProfiles) {
    const rows = bySlug.get(row.slug) ?? [];
    rows.push(row);
    bySlug.set(row.slug, rows);
  }
  const twins: TwinGroup[] = [...bySlug.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .map(([slug, rows]) => ({ slug, rows }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const reservedRows = input.activeProfiles.filter((p) =>
    isReservedProfileSlug(p.slug)
  );
  const retirements = retired.map((entry) => {
    if (!present.has(entry.profileSlug)) {
      return { ...entry, state: "profile_absent" as const, linkedSlugs: [] };
    }
    // Same link set the boot pass reads: every link on the profile.
    const links = input.systemLinks
      .filter((l) => l.profileSlug === entry.profileSlug)
      .map((l) => ({ propertyDefId: l.propertyDefId, slug: l.defSlug }));
    const plan = planRetirementUnlink(links, entry.propertySlug);
    if (plan.kind === "unlink") {
      return { ...entry, state: "pending" as const, linkedSlugs: [plan.slug] };
    }
    if (plan.kind === "ambiguous") {
      return { ...entry, state: "ambiguous" as const, linkedSlugs: plan.slugs };
    }
    return { ...entry, state: "inert" as const, linkedSlugs: [] };
  });

  return {
    undeclaredLinks,
    twins,
    reservedRows,
    retirements: retirements.map(
      ({ profileSlug, propertySlug, state, linkedSlugs }) => ({
        profileSlug,
        propertySlug,
        state,
        linkedSlugs,
      })
    ),
  };
}

/**
 * PURE: the section. `attention`, never `degraded` — a schema fossil is a
 * finding to act on, and the pod is serving.
 */
export function summarizeSchemaContract(
  signal: SchemaContractSignal
): HealthSection {
  const outstanding = signal.retirements.filter(
    (r) => r.state === "pending" || r.state === "ambiguous"
  );
  const parts: string[] = [];
  if (signal.undeclaredLinks.length > 0) {
    parts.push(
      `${signal.undeclaredLinks.length} base link(s) on system profiles the current seed does not declare`
    );
  }
  if (signal.twins.length > 0) {
    parts.push(
      `${signal.twins.length} slug(s) held by more than one active profile row`
    );
  }
  if (signal.reservedRows.length > 0) {
    parts.push(
      `${signal.reservedRows.length} active profile row(s) on a reserved slug`
    );
  }
  if (outstanding.length > 0) {
    parts.push(`${outstanding.length} retirement(s) not applied`);
  }
  return {
    key: "schema_contract",
    status: parts.length > 0 ? "attention" : "ok",
    headline:
      parts.length > 0
        ? parts.join("; ")
        : "System-profile schema matches the seed — no undeclared links, no same-slug twins, no reserved-slug rows, no outstanding retirements",
    detail: {
      undeclaredLinks: signal.undeclaredLinks.slice(0, MAX_REPORTED),
      undeclaredTotal: signal.undeclaredLinks.length,
      twins: signal.twins.slice(0, MAX_REPORTED),
      twinsTotal: signal.twins.length,
      reservedRows: signal.reservedRows,
      retirements: signal.retirements,
      notes: {
        undeclared:
          "base-scoped defs only; workspace overlay defs are excluded. A template may legitimately add a base link — undeclared means 'not the seed's', not 'wrong'.",
        twins:
          "a slug held by 2+ active rows in any scopes; workspace rows limited to workspaces you can see",
        reserved:
          "rows on a slug the profile write paths refuse (isReservedProfileSlug) — reactivate/sync are refused too",
        inert:
          "an inert retirement matches no link — already converged, or never present; the schema cannot tell which",
      },
    },
  };
}

/** DB tier: read visible active profiles, and every link on the system ones. */
export async function gatherSchemaContractSignal(params: {
  userId: string;
  workspaceId: string | null;
}): Promise<SchemaContractSignal> {
  // Pod-wide rows (system/shared) are visible to every pod user; workspace rows
  // only in workspaces the caller can see; user rows only the caller's own.
  const activeProfiles: ActiveProfileRow[] = await db
    .select({
      profileId: profiles.id,
      slug: profiles.slug,
      scope: profiles.scope,
      workspaceId: profiles.workspaceId,
    })
    .from(profiles)
    .where(
      and(
        eq(profiles.isActive, true),
        or(
          inArray(profiles.scope, [ProfileScope.SYSTEM, ProfileScope.SHARED]),
          and(
            eq(profiles.scope, ProfileScope.WORKSPACE),
            userVisibleWhere(profiles.workspaceId, params.userId)
          ),
          and(
            eq(profiles.scope, ProfileScope.USER),
            eq(profiles.userId, params.userId)
          )
        )
      )
    );

  const systemIds = activeProfiles
    .filter((p) => p.scope === ProfileScope.SYSTEM)
    .map((p) => p.profileId);
  const systemLinks: SystemLinkRow[] =
    systemIds.length === 0
      ? []
      : await db
          .select({
            profileId: profileProperties.profileId,
            profileSlug: profiles.slug,
            propertyDefId: profileProperties.propertyDefId,
            defSlug: propertyDefs.slug,
            defWorkspaceId: propertyDefs.workspaceId,
          })
          .from(profileProperties)
          .innerJoin(profiles, eq(profiles.id, profileProperties.profileId))
          .innerJoin(
            propertyDefs,
            eq(propertyDefs.id, profileProperties.propertyDefId)
          )
          .where(inArray(profileProperties.profileId, systemIds));

  const signal = classifySchemaContract({ activeProfiles, systemLinks });
  if (!params.workspaceId) return signal;
  // A workspace lens narrows twins and reserved rows to that workspace; the
  // seed-contract lists are pod metadata and are not narrowed.
  const ws = params.workspaceId;
  return {
    ...signal,
    twins: signal.twins.filter((t) => t.rows.some((r) => r.workspaceId === ws)),
    reservedRows: signal.reservedRows.filter((r) => r.workspaceId === ws),
  };
}
