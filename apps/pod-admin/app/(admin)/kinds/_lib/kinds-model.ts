/**
 * Kinds — the kinds of things the pod holds, how many of each, and what
 * needs tidying.
 *
 * PURE: the page's three reads in, rows out — tested at the seam.
 *   • `profiles.list` — every active kind the viewer can see.
 *   • `entities.adminListProfiles` — pod-wide live-record counts BY SLUG.
 *     Twins (several rows on one slug) therefore share ONE count: the records
 *     carry a slug, not a row, so the count is said once per slug and every
 *     twin row says it is shared.
 *   • `diagnose.global` — `schema_hygiene` (kinds with no records) and
 *     `schema_contract` (twins, reserved slugs, undeclared links). Its
 *     `detail` is `Record<string, unknown>` on the wire, so every field is
 *     read through a narrowing helper: a renamed field drops the flag, never
 *     crashes the page or invents one.
 */

import type { StatusKind } from "../../components/status-pill";

export const KINDS_TITLE = "Kinds";
export const KINDS_DESCRIPTION =
  "The kinds of things your pod holds, how many of each, and what needs tidying.";

export interface ProfileLike {
  id: string;
  slug: string;
  displayName: string;
  scope: string;
  workspaceId: string | null;
  profileKind?: string | null;
  uiHints?: unknown;
}

export interface SlugCount {
  profileSlug: string;
  count: number;
}

export interface DiagnoseSectionLike {
  key: string;
  detail: Record<string, unknown>;
}

// ── Narrowing helpers (wire detail is untyped) ───────────────────────────────

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.map(rec).filter((r): r is Record<string, unknown> => r !== null)
    : [];
}
function str(v: Record<string, unknown> | null, key: string): string | null {
  const x = v?.[key];
  return typeof x === "string" && x.length > 0 ? x : null;
}

export interface SchemaFindings {
  /** Profile ids diagnose found with no live record anywhere in the pod. */
  zeroRecordIds: Set<string>;
  /** Slug → the profile ids holding it (2+). */
  twins: Map<string, string[]>;
  reservedIds: Set<string>;
  undeclaredLinks: Array<{ profileSlug: string; propertySlug: string }>;
  /** False when diagnose has not answered (loading or failed). */
  known: boolean;
}

export function schemaFindings(
  sections: readonly DiagnoseSectionLike[] | undefined
): SchemaFindings {
  const hygiene = sections?.find((s) => s.key === "schema_hygiene")?.detail;
  const contract = sections?.find((s) => s.key === "schema_contract")?.detail;
  const zeroRecordIds = new Set(
    list(hygiene?.zeroEntityKinds)
      .map((k) => str(k, "profileId"))
      .filter((id): id is string => id !== null)
  );
  const twins = new Map<string, string[]>();
  for (const t of list(contract?.twins)) {
    const slug = str(t, "slug");
    const ids = list(t.rows)
      .map((r) => str(r, "profileId"))
      .filter((id): id is string => id !== null);
    if (slug && ids.length > 1) twins.set(slug, ids);
  }
  const reservedIds = new Set(
    list(contract?.reservedRows)
      .map((r) => str(r, "profileId"))
      .filter((id): id is string => id !== null)
  );
  const undeclaredLinks = list(contract?.undeclaredLinks).flatMap((l) => {
    const profileSlug = str(l, "profileSlug");
    const propertySlug = str(l, "propertySlug");
    return profileSlug && propertySlug ? [{ profileSlug, propertySlug }] : [];
  });
  return {
    zeroRecordIds,
    twins,
    reservedIds,
    undeclaredLinks,
    known: sections !== undefined,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export function scopeLabel(
  p: Pick<ProfileLike, "scope" | "workspaceId">,
  workspaceNames: ReadonlyMap<string, string>
): string {
  switch (p.scope) {
    case "system":
      return "System";
    case "shared":
      return "Shared";
    case "user":
      return "Personal";
    default:
      return p.workspaceId
        ? (workspaceNames.get(p.workspaceId) ?? "A space")
        : "Space";
  }
}

export interface KindRow {
  id: string;
  slug: string;
  name: string;
  scope: string;
  /** Live records on this slug pod-wide; null for a role (never a record's kind). */
  records: number | null;
  /** Other rows on the same slug — the count above is theirs too. */
  twinCount: number;
  pill: { kind: StatusKind; label: string } | null;
  profile: ProfileLike;
}

/**
 * One pill, the most pressing first: a reserved slug (the write paths refuse
 * it), a duplicate slug, then no records. Nothing when the kind is fine.
 */
export function kindPill(
  id: string,
  slug: string,
  f: SchemaFindings
): { kind: StatusKind; label: string } | null {
  if (f.reservedIds.has(id)) return { kind: "down", label: "Reserved" };
  if (f.twins.has(slug)) return { kind: "stale", label: "Duplicate slug" };
  if (f.zeroRecordIds.has(id)) return { kind: "stale", label: "No records" };
  return null;
}

export function kindRows(
  profiles: readonly ProfileLike[],
  counts: readonly SlugCount[] | null,
  f: SchemaFindings,
  workspaceNames: ReadonlyMap<string, string>
): KindRow[] {
  const bySlug = new Map((counts ?? []).map((c) => [c.profileSlug, c.count]));
  const rowsPerSlug = new Map<string, number>();
  for (const p of profiles)
    rowsPerSlug.set(p.slug, (rowsPerSlug.get(p.slug) ?? 0) + 1);
  return profiles
    .map((p): KindRow => {
      const role = p.profileKind === "role";
      return {
        id: p.id,
        slug: p.slug,
        name: p.displayName || p.slug,
        scope: scopeLabel(p, workspaceNames),
        records: role || counts === null ? null : (bySlug.get(p.slug) ?? 0),
        twinCount: (rowsPerSlug.get(p.slug) ?? 1) - 1,
        pill: kindPill(p.id, p.slug, f),
        profile: p,
      };
    })
    .sort(
      (a, b) =>
        Number(b.pill !== null) - Number(a.pill !== null) ||
        a.name.localeCompare(b.name) ||
        a.scope.localeCompare(b.scope)
    );
}

export function recordsLine(row: KindRow): string {
  if (row.records === null)
    return row.profile.profileKind === "role" ? "Role" : "—";
  const n = `${row.records} ${row.records === 1 ? "record" : "records"}`;
  return row.twinCount > 0
    ? `${n} across ${row.twinCount + 1} kinds named “${row.slug}”`
    : n;
}

// ── Needs tidying ────────────────────────────────────────────────────────────

export type TidyAction =
  /** `profiles.proposeRetire` in the kind's own space — goes to Review. */
  | { kind: "retire"; profileId: string; workspaceId: string }
  /** Nothing this page can do safely — the app's Data › Kinds. */
  | { kind: "app" };

export interface TidyItem {
  key: string;
  title: string;
  sentence: string;
  action: TidyAction;
  /** The kinds-list row this item is about, for `?focus=`. */
  focusId: string | null;
}

/**
 * The tidying list: kinds with no records, then twins, then links the seed no
 * longer declares — one action each.
 *
 * Retire is offered only for a SPACE kind: `profiles.proposeRetire` is a
 * `workspaceProcedure` and files the proposal in the acting space, so the
 * kind's own space is the only honest header. A shared or personal kind has
 * none, and picking one would file the proposal somewhere arbitrary — those
 * go to the app.
 */
export function tidyItems(
  rows: readonly KindRow[],
  f: SchemaFindings
): TidyItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: TidyItem[] = [];

  for (const id of f.zeroRecordIds) {
    const row = byId.get(id);
    if (!row) continue;
    const ws = row.profile.workspaceId;
    items.push({
      key: `zero:${id}`,
      title: row.name,
      sentence: `No record in the pod is a ${row.name}. Retiring hides the kind everywhere; nothing is deleted and it can be brought back.`,
      action:
        row.profile.scope === "workspace" && ws
          ? { kind: "retire", profileId: id, workspaceId: ws }
          : { kind: "app" },
      focusId: id,
    });
  }

  for (const [slug, ids] of f.twins) {
    const named = ids
      .map((id) => byId.get(id))
      .filter((r): r is KindRow => r !== undefined);
    const where = named.map((r) => r.scope).join(", ");
    items.push({
      key: `twin:${slug}`,
      title: named[0]?.name ?? slug,
      sentence: `${ids.length} kinds are named “${slug}”${where ? ` (${where})` : ""}, so a new record can land in either and agents see only one. Merge them in the app; a merge proposal, once filed, waits in Review.`,
      action: { kind: "app" },
      focusId: named[0]?.id ?? null,
    });
  }

  for (const l of f.undeclaredLinks) {
    const row = rows.find(
      (r) => r.slug === l.profileSlug && r.profile.scope === "system"
    );
    items.push({
      key: `link:${l.profileSlug}:${l.propertySlug}`,
      title: row?.name ?? l.profileSlug,
      sentence: `Carries the field “${l.propertySlug}”, which the current system schema no longer declares. It may be a template’s addition — check before removing it in the app.`,
      action: { kind: "app" },
      focusId: row?.id ?? null,
    });
  }

  return items;
}

/** `profiles.proposeRetire`'s answer, as one sentence. */
export type RetireResult =
  | { status: "proposed"; proposalId: string }
  | { status: "already_pending"; proposalId: string }
  | { status: "already_retired" }
  | {
      status: "refused";
      reasons: string[];
      mergeProposalId: string | null;
      noMergeReason: string | null;
    };

export function retireOutcome(r: RetireResult): {
  message: string;
  proposalId: string | null;
} {
  switch (r.status) {
    case "proposed":
      return { message: "Sent to Review.", proposalId: r.proposalId };
    case "already_pending":
      return {
        message: "Already waiting in Review.",
        proposalId: r.proposalId,
      };
    case "already_retired":
      return { message: "Already retired.", proposalId: null };
    case "refused": {
      const why = r.reasons[0] ? `${r.reasons[0]} ` : "";
      return r.mergeProposalId
        ? {
            message: `${why}A merge was sent to Review instead.`.trim(),
            proposalId: r.mergeProposalId,
          }
        : {
            message:
              `${why}${r.noMergeReason ?? "It can’t be retired."}`.trim(),
            proposalId: null,
          };
    }
  }
}
