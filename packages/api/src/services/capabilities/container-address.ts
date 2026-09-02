/**
 * Capability CONTAINER identity — the ONE resolver for a container's address.
 *
 * A container has no remote object to point at, so its identity is its
 * TERRAFORM ADDRESS: `(templateKey, scope)` — the template it was instantiated
 * from, within a workspace (NULL = pod-wide). Migration 0242 promoted that from
 * a `metadata.templateKey` stamp to a real column with a PARTIAL unique index
 * (`capabilities_template_key_scope_uq`, `WHERE template_key IS NOT NULL`).
 *
 * That index makes a bare `db.insert(capabilities)` crash-prone: two containers
 * at the same address now raise 23505 instead of silently duplicating. In the
 * proposal executor that would throw BEFORE `proposals.status` is updated,
 * leaving an opaque 500 and a proposal that can never be approved — strictly
 * worse than the duplicate the index replaced. Every container-creating door
 * therefore goes through `resolveOrCreateContainer`, which resolves the address
 * first and treats a lost race as a resolve rather than an error.
 */
import { and, eq, isNull } from "@synap/database";
import type { db as Db } from "@synap/database";
// Tables come from the schema entrypoint, operators/db from the barrel — the
// convention every router here already follows.
import { capabilities } from "@synap/database/schema";
import type { CapabilityRow } from "@synap/database/schema";

type DbLike = typeof Db;

/** `NULL workspace_id` = pod-wide, and it participates in uniqueness. */
export function containerScopeWhere(workspaceId: string | null | undefined) {
  return workspaceId
    ? eq(capabilities.workspaceId, workspaceId)
    : isNull(capabilities.workspaceId);
}

/**
 * ADDRESS first, then name. `name` is a DISPLAY string upstream is free to
 * change, and a renamed template used to mint a second container; `templateKey`
 * is the stable address the unique index is built on. Name+scope stays as the
 * fallback so a pre-0242 container (stamped in `metadata` but with a NULL
 * column) is still reused — the caller's stamp then fills the column in and it
 * converges to address-resolution on the next pass.
 */
export async function findContainerByAddress(
  db: DbLike,
  args: {
    templateKey?: string | null;
    name?: string | null;
    workspaceId?: string | null;
  }
): Promise<CapabilityRow | undefined> {
  const scope = containerScopeWhere(args.workspaceId);
  if (args.templateKey) {
    const [byAddress] = await db
      .select()
      .from(capabilities)
      .where(and(eq(capabilities.templateKey, args.templateKey), scope))
      .limit(1);
    if (byAddress) return byAddress as CapabilityRow;
  }
  if (!args.name) return undefined;
  const [byName] = await db
    .select()
    .from(capabilities)
    .where(and(eq(capabilities.name, args.name), scope))
    .limit(1);
  return byName as CapabilityRow | undefined;
}

export type ContainerInsert = {
  workspaceId: string | null;
  createdBy: string;
  name: string;
  description?: string | null;
  templateKey?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * The ONE container-creating door. Resolve-then-insert is TOCTOU on its own, so
 * the insert is `onConflictDoNothing` and a swallowed conflict re-reads the
 * address — the row the winner just wrote. `status` tells the caller which
 * happened; no door needs to know about 23505.
 */
export async function resolveOrCreateContainer(
  db: DbLike,
  values: ContainerInsert
): Promise<{ container: CapabilityRow; status: "created" | "reused" }> {
  const existing = await findContainerByAddress(db, {
    templateKey: values.templateKey,
    name: values.name,
    workspaceId: values.workspaceId,
  });
  if (existing) return { container: existing, status: "reused" };

  const [inserted] = await db
    .insert(capabilities)
    .values({
      workspaceId: values.workspaceId,
      createdBy: values.createdBy,
      name: values.name,
      description: values.description ?? undefined,
      templateKey: values.templateKey ?? null,
      ...(values.metadata ? { metadata: values.metadata } : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted)
    return { container: inserted as CapabilityRow, status: "created" };

  // Lost the race on the address index — the winner's row IS the answer.
  const raced = await findContainerByAddress(db, {
    templateKey: values.templateKey,
    name: values.name,
    workspaceId: values.workspaceId,
  });
  if (raced) return { container: raced, status: "reused" };
  throw new Error(
    `capability container insert conflicted at address (${values.templateKey ?? "—"}, ${values.workspaceId ?? "pod-wide"}) but no row resolves there`
  );
}
