import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  buildPropertyUnion,
  isEmptyPropertyValue,
  type PropertyConflict,
} from "@synap/database";
import { assertApplied } from "./shared.js";

/**
 * Approve-time choice when an entity/create hits the weak same-name gate.
 * ONE policy for the single-entity executor and composite materialize.
 * `mergeEntities` is the door for two live rows — a rejected create has no
 * second row, so these verbs never call it.
 */
export const identityResolutionInput = z.object({
  verb: z.enum(["fill_empty", "keep_existing", "use_capture", "separate"]),
  existingEntityId: z.string().uuid().optional(),
});

export type IdentityResolutionInput = z.infer<typeof identityResolutionInput>;

export const identityResolutionByRefInput = z.record(
  z.string(),
  identityResolutionInput
);

export interface IdentityConflict {
  key: string;
  kept: unknown;
  incoming: unknown;
}

export interface IdentityReceipt {
  verb: IdentityResolutionInput["verb"];
  entityId: string;
  filled?: string[];
  conflicts?: IdentityConflict[];
}

export interface IdentityEntitySnapshot {
  id: string;
  title: string | null;
  description: string | null;
  /** Inline body (`properties.content`). Null when absent. */
  content: string | null;
  /** Linked document holds the body — content is then non-empty even if inline is blank. */
  documentId: string | null;
  properties: Record<string, unknown>;
}

export interface ProposedIdentityFields {
  title?: string | null;
  description?: string | null;
  content?: string | null;
  properties?: Record<string, unknown> | null;
}

export interface IdentityUpdatePatch {
  id: string;
  title?: string;
  description?: string;
  properties?: Record<string, unknown>;
  source: "system";
}

export type IdentityApplication =
  { forceCreate: true } | { forceCreate: false; receipt: IdentityReceipt };

/** fill_empty / keep_existing / use_capture need a target. separate does not. */
export function assertIdentityResolutionTarget(
  resolution: IdentityResolutionInput
): void {
  if (resolution.verb === "separate") return;
  if (!resolution.existingEntityId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `identityResolution.existingEntityId is required for ${resolution.verb}`,
    });
  }
}

export function snapshotFromApiEntity(
  entity: Record<string, unknown>
): IdentityEntitySnapshot {
  const properties =
    entity.properties &&
    typeof entity.properties === "object" &&
    !Array.isArray(entity.properties)
      ? (entity.properties as Record<string, unknown>)
      : {};
  const inline = properties.content;
  const description =
    typeof entity.description === "string"
      ? entity.description
      : typeof entity.preview === "string"
        ? entity.preview
        : null;
  return {
    id: String(entity.id),
    title: typeof entity.title === "string" ? entity.title : null,
    description,
    content: typeof inline === "string" ? inline : null,
    documentId:
      typeof entity.documentId === "string" ? entity.documentId : null,
    properties,
  };
}

/**
 * Visibility-scoped read. A hidden or missing row is NOT_FOUND with no id in
 * the message — the approver must not learn that a hidden row exists.
 */
export async function loadIdentitySnapshot(
  get: (input: {
    id: string;
  }) => Promise<{ entity?: Record<string, unknown> | null } | null>,
  id: string
): Promise<IdentityEntitySnapshot> {
  let got: { entity?: Record<string, unknown> | null } | null;
  try {
    got = await get({ id });
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
    }
    throw err;
  }
  const entity = got?.entity;
  if (!entity || entity.id !== id) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
  }
  return snapshotFromApiEntity(entity);
}

function notFoundWithoutId(err: unknown): never {
  if (err instanceof TRPCError && err.code === "NOT_FOUND") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
  }
  throw err;
}

/** Ports both approve paths use so the write door cannot fork. */
export function entityIdentityPorts(caller: {
  get?: (input: {
    id: string;
  }) => Promise<{ entity?: Record<string, unknown> | null } | null>;
  update?: (input: IdentityUpdatePatch) => Promise<unknown>;
}): {
  load: (id: string) => Promise<IdentityEntitySnapshot>;
  update: (patch: IdentityUpdatePatch) => Promise<unknown>;
} {
  return {
    load: (id) => {
      if (!caller.get) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "identity resolution requires entities.get",
        });
      }
      return loadIdentitySnapshot(caller.get, id);
    },
    update: async (patch) => {
      if (!caller.update) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "identity resolution requires entities.update",
        });
      }
      try {
        const result = await caller.update(patch);
        assertApplied(
          result && typeof result === "object"
            ? (result as { status?: string })
            : undefined
        );
        return result;
      } catch (err) {
        notFoundWithoutId(err);
      }
    },
  };
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function toConflict(conflict: PropertyConflict): IdentityConflict {
  return {
    key: conflict.key,
    kept: conflict.winnerValue,
    incoming: conflict.loserValue,
  };
}

/**
 * Body text the empty-test sees. A linked document counts as non-empty even
 * when `properties.content` is blank — fill_empty must not treat that as a hole.
 * The kept value is the document id because the text lives in storage.
 */
function storedContent(existing: IdentityEntitySnapshot): unknown {
  if (!isEmptyPropertyValue(existing.content)) return existing.content;
  if (existing.documentId) return existing.documentId;
  return null;
}

function proposedPropertyBag(
  proposed: ProposedIdentityFields
): Record<string, unknown> {
  const bag = { ...(proposed.properties ?? {}) };
  // The scalar `content` field owns the body slot when it has text, so the
  // property union cannot also write `properties.content`.
  if (
    typeof proposed.content === "string" &&
    !isEmptyPropertyValue(proposed.content)
  ) {
    delete bag.content;
  }
  return bag;
}

export interface IdentityFieldPlan {
  title?: string;
  description?: string;
  properties?: Record<string, unknown>;
  filled: string[];
  conflicts: IdentityConflict[];
}

/**
 * Pure field policy. fill_empty never overwrites a non-empty value.
 * use_capture replaces non-empty proposed fields and skips empty ones
 * (an empty proposed field must not blank a stored value).
 */
export function planIdentityFields(
  verb: "fill_empty" | "use_capture",
  existing: IdentityEntitySnapshot,
  proposed: ProposedIdentityFields
): IdentityFieldPlan {
  const filled: string[] = [];
  const conflicts: IdentityConflict[] = [];
  let title: string | undefined;
  let description: string | undefined;
  let contentWrite: string | undefined;

  const consider = (
    key: "title" | "description" | "content",
    stored: unknown,
    incoming: unknown,
    write: (value: string) => void
  ) => {
    if (typeof incoming !== "string" || isEmptyPropertyValue(incoming)) return;
    if (verb === "use_capture") {
      write(incoming);
      return;
    }
    if (isEmptyPropertyValue(stored)) {
      write(incoming);
      filled.push(key);
      return;
    }
    if (!sameScalar(stored, incoming)) {
      conflicts.push({ key, kept: stored, incoming });
    }
  };

  consider("title", existing.title, proposed.title, (value) => {
    title = value;
  });
  consider(
    "description",
    existing.description,
    proposed.description,
    (value) => {
      description = value;
    }
  );
  consider("content", storedContent(existing), proposed.content, (value) => {
    contentWrite = value;
  });

  const bag = proposedPropertyBag(proposed);
  const properties: Record<string, unknown> = {};
  if (verb === "fill_empty") {
    const union = buildPropertyUnion(existing.properties ?? {}, bag);
    for (const key of union.filled) {
      properties[key] = union.merged[key];
      filled.push(key);
    }
    for (const conflict of union.conflicts)
      conflicts.push(toConflict(conflict));
  } else {
    for (const [key, value] of Object.entries(bag)) {
      if (isEmptyPropertyValue(value)) continue;
      properties[key] = value;
    }
  }
  if (contentWrite !== undefined) properties.content = contentWrite;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    filled,
    conflicts,
  };
}

export async function applyIdentityResolution(args: {
  resolution: IdentityResolutionInput;
  proposed: ProposedIdentityFields;
  load: (id: string) => Promise<IdentityEntitySnapshot | null>;
  update: (patch: IdentityUpdatePatch) => Promise<unknown>;
}): Promise<IdentityApplication> {
  if (args.resolution.verb === "separate") {
    // The only bypass of the weak same-name gate. Caller passes forceCreate.
    return { forceCreate: true };
  }
  assertIdentityResolutionTarget(args.resolution);
  const id = args.resolution.existingEntityId as string;
  let existing: IdentityEntitySnapshot | null;
  try {
    existing = await args.load(id);
  } catch (err) {
    // Same rewrite as loadIdentitySnapshot: a visibility NOT_FOUND from
    // entities.get/update includes the id, and this door must not.
    if (err instanceof TRPCError && err.code === "NOT_FOUND") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
    }
    throw err;
  }
  if (!existing || existing.id !== id) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
  }

  if (args.resolution.verb === "keep_existing") {
    return {
      forceCreate: false,
      receipt: { verb: "keep_existing", entityId: id },
    };
  }

  const plan = planIdentityFields(
    args.resolution.verb,
    existing,
    args.proposed
  );
  const patch: IdentityUpdatePatch = { id, source: "system" };
  if (plan.title !== undefined) patch.title = plan.title;
  if (plan.description !== undefined) patch.description = plan.description;
  if (plan.properties) patch.properties = plan.properties;
  if (
    plan.title !== undefined ||
    plan.description !== undefined ||
    plan.properties
  ) {
    await args.update(patch);
  }

  const receipt: IdentityReceipt = {
    verb: args.resolution.verb,
    entityId: id,
  };
  if (args.resolution.verb === "fill_empty") {
    receipt.filled = plan.filled;
    receipt.conflicts = plan.conflicts;
  }
  return { forceCreate: false, receipt };
}
