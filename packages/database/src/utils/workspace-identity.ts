/**
 * Workspace identity — the ONE door for "no two active spaces share a name,
 * and no two active spaces come from the same template" (founder 2026-10-06,
 * pod-wide, no user link). Enforced by the 0308 partial unique indexes;
 * every write door goes through here so a refusal is a typed 409, never a raw
 * SQLSTATE 23505 surfaced as a 500.
 *
 * Two layers, both needed:
 *   - `findWorkspaceIdentityConflict` — the pre-check. Names the EXISTING
 *     space (so a door can hand it back or say which one), and runs BEFORE the
 *     write so a caller's transaction is not aborted by the index.
 *   - `toWorkspaceIdentityError` — the race backstop. Maps a 23505 from either
 *     0308 index to the same typed error (no lookup: the transaction may
 *     already be aborted).
 *
 * `nextFreeWorkspaceName` is for SYSTEM-GENERATED default names only
 * ("My Workspace", "<agentType> Knowledge Base"). A name a person typed is
 * never suffixed — it gets the typed conflict instead (founder decision (a)).
 */
import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { ConflictError } from "@synap-core/core";
import { workspaces } from "../schema/workspaces.js";

export const WORKSPACE_ACTIVE_NAME_INDEX = "workspaces_active_name_unique";
export const WORKSPACE_ACTIVE_PACKAGE_SLUG_INDEX =
  "workspaces_active_package_slug_unique";

export type WorkspaceIdentityField = "name" | "packageSlug";

/** Machine code forwarded on the tRPC error (`error.data.reasonCode`). */
export const WORKSPACE_IDENTITY_CONFLICT = "WORKSPACE_IDENTITY_CONFLICT";

export class WorkspaceIdentityConflictError extends ConflictError {
  readonly reasonCode = WORKSPACE_IDENTITY_CONFLICT;
  constructor(
    public readonly field: WorkspaceIdentityField,
    public readonly value: string,
    /** The active space that already holds it; null when only the index saw it. */
    public readonly existingWorkspaceId: string | null
  ) {
    super(
      field === "name"
        ? `A space named "${value}" already exists. Space names are unique on this pod — open the existing space, or pick another name.`
        : `The template "${value}" is already installed on this pod${existingWorkspaceId ? ` (space ${existingWorkspaceId})` : ""}. A template is installed once — update the existing space instead of installing a second copy.`,
      { field, value, existingWorkspaceId }
    );
    this.name = "WorkspaceIdentityConflictError";
  }
}

export function isWorkspaceIdentityConflictError(
  err: unknown
): err is WorkspaceIdentityConflictError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { reasonCode?: unknown }).reasonCode === WORKSPACE_IDENTITY_CONFLICT
  );
}

/** The key the name index compares on — keep in lock-step with 0308. */
export function workspaceNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

/**
 * The first identity an ACTIVE space other than `excludeId` already holds,
 * name checked first. `packageSlug` null/undefined = not checked.
 */
export async function findWorkspaceIdentityConflict(
  executor: Executor,
  input: {
    name?: string | null;
    packageSlug?: string | null;
    excludeId?: string | null;
  }
): Promise<{
  field: WorkspaceIdentityField;
  value: string;
  existingWorkspaceId: string;
} | null> {
  const notSelf: SQL[] = input.excludeId
    ? [ne(workspaces.id, input.excludeId)]
    : [];
  if (input.name != null && input.name.trim() !== "") {
    const [hit] = await executor
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(
        and(
          sql`lower(btrim(${workspaces.name})) = ${workspaceNameKey(input.name)}`,
          isNull(workspaces.archivedAt),
          ...notSelf
        )
      )
      .limit(1);
    if (hit) {
      return {
        field: "name",
        value: input.name.trim(),
        existingWorkspaceId: hit.id,
      };
    }
  }
  if (input.packageSlug) {
    const [hit] = await executor
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.packageSlug, input.packageSlug),
          isNull(workspaces.archivedAt),
          ...notSelf
        )
      )
      .limit(1);
    if (hit) {
      return {
        field: "packageSlug",
        value: input.packageSlug,
        existingWorkspaceId: hit.id,
      };
    }
  }
  return null;
}

/** Pre-check that throws the typed conflict. */
export async function assertWorkspaceIdentityFree(
  executor: Executor,
  input: {
    name?: string | null;
    packageSlug?: string | null;
    excludeId?: string | null;
  }
): Promise<void> {
  const hit = await findWorkspaceIdentityConflict(executor, input);
  if (hit) {
    throw new WorkspaceIdentityConflictError(
      hit.field,
      hit.value,
      hit.existingWorkspaceId
    );
  }
}

/**
 * Which 0308 index a caught error violated, walking the cause chain (drizzle
 * may wrap the driver error). postgres.js names it `constraint_name`, PGlite
 * `constraint`.
 */
export function workspaceIdentityViolation(
  err: unknown
): WorkspaceIdentityField | null {
  let cursor: unknown = err;
  for (
    let depth = 0;
    cursor && typeof cursor === "object" && depth < 5;
    depth++
  ) {
    const c = cursor as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (c.code === "23505") {
      const name = c.constraint_name ?? c.constraint;
      if (name === WORKSPACE_ACTIVE_NAME_INDEX) return "name";
      if (name === WORKSPACE_ACTIVE_PACKAGE_SLUG_INDEX) return "packageSlug";
      return null;
    }
    cursor = c.cause;
  }
  return null;
}

/**
 * Rethrow helper for the race backstop: a 23505 on a 0308 index becomes the
 * typed conflict; anything else is returned unchanged for the caller to throw.
 */
export function toWorkspaceIdentityError(
  err: unknown,
  attempted: { name?: string | null; packageSlug?: string | null }
): unknown {
  const field = workspaceIdentityViolation(err);
  if (!field) return err;
  const value =
    (field === "name" ? attempted.name?.trim() : attempted.packageSlug) ?? "";
  return new WorkspaceIdentityConflictError(field, value, null);
}

/**
 * For SYSTEM-GENERATED default names only: `base` when free, else
 * "base (2)", "base (3)"… — the first one no active space holds. Same suffix
 * shape the 0308 dedupe uses. Never call this on a name a person typed.
 */
export async function nextFreeWorkspaceName(
  executor: Executor,
  base: string
): Promise<string> {
  const trimmed = base.trim();
  // Every active name (a pod holds tens of spaces): the exact-key compare
  // below is the rule, so no SQL prefilter can disagree with it.
  const rows: Array<{ name: string }> = await executor
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(isNull(workspaces.archivedAt));
  const taken = new Set(rows.map((r) => workspaceNameKey(r.name)));
  if (!taken.has(workspaceNameKey(trimmed))) return trimmed;
  for (let n = 2; ; n++) {
    const candidate = `${trimmed} (${n})`;
    if (!taken.has(workspaceNameKey(candidate))) return candidate;
  }
}
