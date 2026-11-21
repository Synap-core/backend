/**
 * Tool ADD-ONS (founder decision D6, document b387ca45 §6; design ac700298).
 *
 * An add-on is a capability with its own container, package and listing that
 * EXTENDS a base capability (e.g. "LinkedIn profiles" extends Apify). Its
 * definition names the base by key (`CapabilityDefinition.extends`) and
 * declares no tool or credential of its own: its skills `require` the base's
 * tools by name, so its actions run through the base's tool rows, and switching
 * the base's access off stops them (the provider dispatch gates a call through
 * an off tool row even inside a decided verb, `coveredByVerb`).
 *
 * No new state: its on/off is its actions' switches, its approvals name its
 * actions. The ONE thing this module stores is the instance relation
 * `capability(add-on) --extends--> capability(base)` in `links`, written by
 * `createCapabilityFromDefinition` once the add-on's container exists.
 *
 * The install rule, enforced by `resolveAddOnBase` BEFORE the applier writes
 * anything:
 *   - the base must be installed in a scope that covers the add-on: a
 *     pod-wide base covers the pod and every space, a space's base covers only
 *     that space;
 *   - the add-on declares no `tools` and no `vault`;
 *   - an add-on does not extend itself.
 * Its actions are members of the add-on only: an install that reuses, by name,
 * a skill that is a member of the base (today's Apify verbs) moves it.
 */

import { TRPCError } from "@trpc/server";
import { and, drizzleSql, eq, inArray } from "@synap/database";
import type { db as Db } from "@synap/database";
import {
  capabilities as capabilitiesTable,
  links,
  tools as toolsTable,
} from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { findContainerByAddress } from "./container-address.js";
import { mergeVerbCatalog } from "./verb-catalog.js";

type DbLike = typeof Db;

/** The installed base an add-on is applied onto. */
export interface AddOnBase {
  id: string;
  name: string;
  workspaceId: string | null;
  /** The base's member tool rows, by NAME: what the add-on's `requires` resolve to. */
  toolIdByName: Map<string, string>;
}

/** What an add-on's definition declares that the install rule reads. */
export interface AddOnDefinitionShape {
  key: string;
  name: string;
  extends?: string | null;
  tools?: readonly unknown[];
  vault?: readonly unknown[];
}

/**
 * The installed base for an add-on definition, or null for a plain
 * capability. THROWS (nothing has been written yet) when the definition is not
 * a valid add-on or its base is not installed in a scope that covers it.
 *
 * `workspaceId` is the scope the add-on installs into (the applier's
 * `connWorkspaceId`): null = pod-wide.
 */
export async function resolveAddOnBase(
  database: DbLike,
  def: AddOnDefinitionShape,
  workspaceId: string | null
): Promise<AddOnBase | null> {
  if (def.extends === undefined || def.extends === null) return null;
  const baseKey = typeof def.extends === "string" ? def.extends.trim() : "";
  if (!baseKey)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${def.name}" names an empty base in \`extends\`.`,
    });
  if (baseKey === def.key)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${def.name}" cannot be an add-on of itself.`,
    });
  if ((def.tools?.length ?? 0) > 0 || (def.vault?.length ?? 0) > 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${def.name}" is an add-on of "${baseKey}": it uses ${baseKey}'s connection and declares no tool or credential of its own.`,
    });

  // A pod-wide base covers every scope; a space's base covers only that space.
  const base =
    (await findContainerByAddress(database, {
      templateKey: baseKey,
      workspaceId: null,
    })) ??
    (workspaceId
      ? await findContainerByAddress(database, {
          templateKey: baseKey,
          workspaceId,
        })
      : undefined);
  if (!base)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: workspaceId
        ? `"${def.name}" is an add-on of "${baseKey}". Install ${baseKey} for the whole pod or in this space first, then add "${def.name}".`
        : `"${def.name}" is an add-on of "${baseKey}". Install ${baseKey} for the whole pod first, then add "${def.name}".`,
    });

  const memberTools = await database
    .select({ id: toolsTable.id, name: toolsTable.name })
    .from(links)
    .innerJoin(toolsTable, eq(drizzleSql`${toolsTable.id}::text`, links.fromId))
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.toType, "capability"),
        eq(links.toId, base.id),
        eq(links.linkType, "member_of")
      )
    );
  return {
    id: base.id,
    name: base.name,
    workspaceId: base.workspaceId ?? null,
    toolIdByName: new Map(memberTools.map((t) => [t.name, t.id])),
  };
}

/**
 * Record `capability(add-on) --extends--> capability(base)`. Idempotent on the
 * unique edge index. Stamped with the add-on's scope.
 */
export async function writeExtendsEdge(
  database: DbLike,
  args: {
    addOnId: string;
    baseId: string;
    workspaceId: string | null;
    userId: string;
  }
): Promise<void> {
  await database
    .insert(links)
    .values({
      workspaceId: args.workspaceId,
      fromType: "capability",
      fromId: args.addOnId,
      toType: "capability",
      toId: args.baseId,
      linkType: "extends",
      metadata: {},
      createdBy: args.userId,
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    });
}

/** The add-on's skills that are still members of its base: the ones to move. */
export async function skillsStillInBase(
  database: DbLike,
  baseId: string,
  skillIds: readonly string[]
): Promise<string[]> {
  if (skillIds.length === 0) return [];
  const rows = await database
    .select({ id: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        inArray(links.fromId, [...skillIds]),
        eq(links.toType, "capability"),
        eq(links.toId, baseId),
        eq(links.linkType, "member_of")
      )
    );
  return rows.map((r) => r.id);
}

/**
 * List the add-on's actions on the base tool they run through, so agents
 * discover them under that connection: the same additive catalogue merge a
 * pod-local verb gets (`wireCreatedVerb`) and a template re-apply uses.
 */
export async function catalogueAddOnVerbsOnBaseTool(
  database: DbLike,
  toolId: string,
  verbs: ToolVerbCatalogEntry[]
): Promise<void> {
  if (verbs.length === 0) return;
  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ capabilities: toolsTable.capabilities })
      .from(toolsTable)
      .where(eq(toolsTable.id, toolId))
      .for("update")
      .limit(1);
    if (!locked) return;
    await tx
      .update(toolsTable)
      .set({
        capabilities: mergeVerbCatalog(locked.capabilities, verbs),
        updatedAt: new Date(),
      })
      .where(eq(toolsTable.id, toolId));
  });
}

/** One container as the add-on reads name it. */
export interface AddOnRef {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
}

/**
 * For each of `capabilityIds`, the base it extends, when the reader can see
 * it. One read for a whole list (the Tools list marks each add-on row).
 */
export async function loadAddOnParents(
  database: DbLike,
  userId: string,
  capabilityIds: readonly string[]
): Promise<Map<string, AddOnRef>> {
  const out = new Map<string, AddOnRef>();
  if (capabilityIds.length === 0) return out;
  const rows = await database
    .select({
      addOnId: links.fromId,
      id: capabilitiesTable.id,
      name: capabilitiesTable.name,
      description: capabilitiesTable.description,
      workspaceId: capabilitiesTable.workspaceId,
    })
    .from(links)
    .innerJoin(
      capabilitiesTable,
      eq(drizzleSql`${capabilitiesTable.id}::text`, links.toId)
    )
    .where(
      and(
        eq(links.fromType, "capability"),
        inArray(links.fromId, [...capabilityIds]),
        eq(links.toType, "capability"),
        eq(links.linkType, "extends"),
        userVisibleWhere(capabilitiesTable.workspaceId, userId)
      )
    );
  for (const r of rows)
    out.set(r.addOnId, {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      workspaceId: r.workspaceId ?? null,
    });
  return out;
}

/** The add-ons installed on `baseId` that the reader can see, by name. */
export async function loadAddOnsOf(
  database: DbLike,
  userId: string,
  baseId: string
): Promise<AddOnRef[]> {
  const rows = await database
    .select({
      id: capabilitiesTable.id,
      name: capabilitiesTable.name,
      description: capabilitiesTable.description,
      workspaceId: capabilitiesTable.workspaceId,
    })
    .from(links)
    .innerJoin(
      capabilitiesTable,
      eq(drizzleSql`${capabilitiesTable.id}::text`, links.fromId)
    )
    .where(
      and(
        eq(links.fromType, "capability"),
        eq(links.toType, "capability"),
        eq(links.toId, baseId),
        eq(links.linkType, "extends"),
        userVisibleWhere(capabilitiesTable.workspaceId, userId)
      )
    );
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      workspaceId: r.workspaceId ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Refuse removing a base while add-ons extend it: they run through its tool
 * rows, so removing it would leave them installed and failing at every run.
 * The refusal names the add-ons the person can see and counts the others
 * (installed in spaces they cannot see). Read through the container join, so
 * an `extends` edge left by a removed add-on never holds a base.
 */
export async function assertNoAddOnsOf(
  database: DbLike,
  userId: string,
  base: { id: string; name: string }
): Promise<void> {
  const [{ count }] = await database
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(links)
    .innerJoin(
      capabilitiesTable,
      eq(drizzleSql`${capabilitiesTable.id}::text`, links.fromId)
    )
    .where(
      and(
        eq(links.fromType, "capability"),
        eq(links.toType, "capability"),
        eq(links.toId, base.id),
        eq(links.linkType, "extends")
      )
    );
  if (!count) return;
  const visible = await loadAddOnsOf(database, userId, base.id);
  const hidden = count - visible.length;
  const named = visible.map((a) => `"${a.name}"`);
  if (hidden > 0)
    named.push(
      `${hidden} more in ${hidden === 1 ? "a space" : "spaces"} you cannot see`
    );
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `"${base.name}" has ${count === 1 ? "an add-on" : `${count} add-ons`} installed that run${count === 1 ? "s" : ""} through it: ${named.join(", ")}. Remove ${count === 1 ? "it" : "them"} first, then remove "${base.name}".`,
    cause: {
      code: "CAPABILITY_HAS_ADDONS",
      addOns: visible.map((a) => a.id),
      hiddenCount: hidden,
    },
  });
}
