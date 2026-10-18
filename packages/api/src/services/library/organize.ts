/**
 * An AGENT proposes how to ORGANISE the person's Library — never its content.
 *
 * Founder rule (2026-10-13, widened 2026-10-18): nothing an agent SENDS lands
 * in the Library (its words, links and files go to `synap_capture`); an agent
 * may PROPOSE how to organise what is already there — create a group (with
 * existing items, a note), add / remove existing items of a group, rename it,
 * set its note or the space Build files into, ask for a group to be built.
 *
 *   file  — {@link proposeLibraryOrganize}: references checked (the person's
 *           own groups and items), names and titles captured for the card,
 *           then THE governed door `checkPermissionOrPropose`
 *           (`library/organize`) with `forcePropose`: for an agent the answer
 *           is a pending proposal or a denial, never an execution.
 *   apply — {@link applyLibraryOrganize} (the approval half,
 *           `routers/proposals/executors/library.ts`): the SAME
 *           `curateLibrary` the person's own edits run, then the SAME
 *           `buildLibraryGroup` for a build request (whose bundle is reviewed
 *           as always) — owner-floored on the proposal's subject.
 *
 * A person never files here: their edits are direct (`library.curate`,
 * `library.build`).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db as defaultDb,
  documents,
  libraryGroups,
  proposals,
  and,
  eq,
  inArray,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  IMPORT_LIMITS,
  LIBRARY_ORGANIZE_DOOR,
  LIBRARY_ORGANIZE_OPS_MAX,
  type ImportBuildResult,
  type LibraryCurateOp,
  type LibraryCurateResult,
  type LibraryOrganizeOp,
  type LibraryOrganizeProposalData,
  type LibraryProposeResult,
} from "@synap-core/types/imports";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import type { ImportBuildDeps } from "../imports/build.js";
import { isAgentCaller } from "./agent-door.js";
import { libraryItemsWhere, type LibraryDb } from "./read-model.js";

const L = IMPORT_LIMITS;
const uuid = z.string().uuid();
const optIds = z.array(uuid).max(L.itemsMax).optional();

/** THE schema of one organise op — the door and the approval both parse with it. */
export const LibraryOrganizeOpSchema: z.ZodType<LibraryOrganizeOp> =
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("group.create"),
      name: z.string().min(1).max(L.groupNameMax),
      note: z.string().max(L.groupNoteMax).optional(),
      itemIds: optIds,
    }),
    z.object({
      op: z.literal("group.items"),
      groupId: uuid,
      add: optIds,
      remove: optIds,
    }),
    z.object({
      op: z.literal("group.update"),
      groupId: uuid,
      name: z.string().min(1).max(L.groupNameMax).optional(),
      note: z.string().max(L.groupNoteMax).optional(),
      workspaceId: uuid.nullable().optional(),
    }),
    z.object({ op: z.literal("group.build"), groupId: uuid }),
  ]);

export const LibraryProposeInputSchema = z.object({
  ops: z.array(LibraryOrganizeOpSchema).min(1).max(LIBRARY_ORGANIZE_OPS_MAX),
  reasoning: z.string().max(2000).optional(),
});

/** Every existing group / item an op names. */
function referenced(ops: readonly LibraryOrganizeOp[]): {
  groupIds: string[];
  itemIds: string[];
} {
  const groupIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const op of ops) {
    if (op.op === "group.create") {
      for (const id of op.itemIds ?? []) itemIds.add(id);
      continue;
    }
    groupIds.add(op.groupId);
    if (op.op === "group.items") {
      for (const id of [...(op.add ?? []), ...(op.remove ?? [])]) {
        itemIds.add(id);
      }
    }
  }
  return { groupIds: [...groupIds], itemIds: [...itemIds] };
}

/** One line for the card, e.g. `Create group "Recipes" with 4 items`. */
export function organizeSummary(
  ops: readonly LibraryOrganizeOp[],
  groupName: (id: string) => string
): string {
  const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
  const parts = ops.map((op) => {
    switch (op.op) {
      case "group.create":
        return `Create group "${op.name}"${op.itemIds?.length ? ` with ${items(op.itemIds.length)}` : ""}`;
      case "group.items": {
        const g = `"${groupName(op.groupId)}"`;
        const add = op.add?.length ?? 0;
        const rm = op.remove?.length ?? 0;
        return [
          add ? `Add ${items(add)} to ${g}` : "",
          rm ? `Remove ${items(rm)} from ${g}` : "",
        ]
          .filter(Boolean)
          .join(", ");
      }
      case "group.update": {
        const what = [
          op.name !== undefined ? `rename to "${op.name}"` : "",
          op.note !== undefined ? "set its note" : "",
          op.workspaceId !== undefined ? "set where it is built" : "",
        ].filter(Boolean);
        return `Update group "${groupName(op.groupId)}"${what.length ? `: ${what.join(", ")}` : ""}`;
      }
      case "group.build":
        return `Build group "${groupName(op.groupId)}"`;
    }
  });
  const shown = parts.filter(Boolean);
  return shown.length <= 2
    ? shown.join("; ")
    : `${shown.slice(0, 2).join("; ")}; and ${shown.length - 2} more`;
}

/**
 * The names and titles of what the ops reference, owner-floored. A group or
 * item that is not the person's (or does not exist) is a BAD_REQUEST naming
 * it — a proposal that could never apply is not filed.
 */
async function resolveReferences(
  database: LibraryDb,
  userId: string,
  ops: readonly LibraryOrganizeOp[]
): Promise<Pick<LibraryOrganizeProposalData, "groups" | "items">> {
  const { groupIds, itemIds } = referenced(ops);
  const groups = groupIds.length
    ? await database
        .select({ id: libraryGroups.id, name: libraryGroups.name })
        .from(libraryGroups)
        .where(
          and(
            eq(libraryGroups.userId, userId),
            inArray(libraryGroups.id, groupIds)
          )
        )
    : [];
  const items = itemIds.length
    ? await database
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(and(libraryItemsWhere(userId), inArray(documents.id, itemIds)))
    : [];
  const missingGroups = groupIds.filter(
    (id) => !groups.some((g) => g.id === id)
  );
  const missingItems = itemIds.filter((id) => !items.some((i) => i.id === id));
  if (missingGroups.length || missingItems.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: [
        missingGroups.length
          ? `No such group in this Library: ${missingGroups.join(", ")}.`
          : "",
        missingItems.length
          ? `No such item in this Library: ${missingItems.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    items: items.map((i) => ({ id: i.id, title: i.title ?? "" })),
  };
}

/**
 * File an agent's organise proposal. Agents only (a person organises
 * directly); always a proposal — a gate answer that would EXECUTE is refused
 * rather than applied, so no rule or default can let an agent organise the
 * Library unreviewed.
 */
export async function proposeLibraryOrganize(args: {
  database?: LibraryDb;
  userId: string;
  caller: { agentUserId?: string | null; keyType?: string | null };
  ops: LibraryOrganizeOp[];
  reasoning?: string;
  /** Test seam: the governed door. */
  gate?: typeof checkPermissionOrPropose;
}): Promise<LibraryProposeResult> {
  if (!isAgentCaller(args.caller)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A person organises the Library directly (library.curate, library.build); proposals are for agents.",
      cause: { reasonCode: "PERSON_USE_CURATE" },
    });
  }
  const database = args.database ?? defaultDb;
  const refs = await resolveReferences(database, args.userId, args.ops);
  const nameOf = (id: string) =>
    refs.groups.find((g) => g.id === id)?.name ?? "a group";
  const data: LibraryOrganizeProposalData = {
    ops: args.ops,
    ...refs,
    summary: organizeSummary(args.ops, nameOf),
  };
  const gate = args.gate ?? checkPermissionOrPropose;
  const perm = await gate({
    userId: args.userId,
    ...(args.caller.agentUserId
      ? { agentUserId: args.caller.agentUserId }
      : {}),
    subjectType: LIBRARY_ORGANIZE_DOOR.subjectType,
    action: LIBRARY_ORGANIZE_DOOR.action,
    // An agent's caller path: the AI ladder, never the human one (the IS key
    // carries no agent user, so the source says it).
    source: "intelligence",
    // ALWAYS a proposal for an agent (rung 2.1, above every rule and the
    // default whitelist): organising the person's Library is their call.
    forcePropose: true,
    data: data as unknown as Record<string, unknown>,
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm && perm.proposalId) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...("reviewUrl" in perm && perm.reviewUrl
        ? { reviewUrl: perm.reviewUrl as string }
        : {}),
    };
  }
  // Never reached for an agent (forcePropose). Refused, never applied.
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "An agent's Library organisation must be reviewed, but no proposal was filed. Nothing was changed.",
  });
}

/** The curate ops of an organise proposal (identical shapes), in order. */
export function curateOpsOf(
  ops: readonly LibraryOrganizeOp[]
): LibraryCurateOp[] {
  return ops.flatMap((op): LibraryCurateOp[] => {
    switch (op.op) {
      case "group.create":
        return [
          {
            op: "group.create",
            name: op.name,
            ...(op.note !== undefined ? { note: op.note } : {}),
            ...(op.itemIds?.length ? { itemIds: op.itemIds } : {}),
          },
        ];
      case "group.items":
        return [
          {
            op: "group.items",
            groupId: op.groupId,
            ...(op.add?.length ? { add: op.add } : {}),
            ...(op.remove?.length ? { remove: op.remove } : {}),
          },
        ];
      case "group.update":
        return [
          {
            op: "group.update",
            groupId: op.groupId,
            ...(op.name !== undefined ? { name: op.name } : {}),
            ...(op.note !== undefined ? { note: op.note } : {}),
            ...(op.workspaceId !== undefined
              ? { workspaceId: op.workspaceId }
              : {}),
          },
        ];
      case "group.build":
        return [];
    }
  });
}

export interface LibraryOrganizeApplied {
  curate: LibraryCurateResult | null;
  builds: Array<{ groupId: string; result: ImportBuildResult }>;
}

/**
 * Apply an APPROVED organise proposal for its owner: the curate ops in ONE
 * `curateLibrary` call (atomic — a bad op writes nothing), then each build
 * request through `buildLibraryGroup`. The approval half only.
 */
export async function applyLibraryOrganize(args: {
  ownerUserId: string;
  ops: readonly LibraryOrganizeOp[];
  depsFor: (run: { workspaceId: string | null }) => ImportBuildDeps;
  /** Test seams: the person's own doors. */
  curate?: (input: {
    userId: string;
    ops: LibraryCurateOp[];
  }) => Promise<LibraryCurateResult>;
  build?: (input: {
    userId: string;
    groupId: string;
    depsFor: (run: { workspaceId: string | null }) => ImportBuildDeps;
  }) => Promise<ImportBuildResult>;
}): Promise<LibraryOrganizeApplied> {
  const curate =
    args.curate ??
    (async (input: { userId: string; ops: LibraryCurateOp[] }) => {
      const { adoptImportGroups } = await import("./groups.js");
      const { curateLibrary } = await import("./curate.js");
      await adoptImportGroups({ userId: input.userId });
      return curateLibrary(input);
    });
  const build =
    args.build ??
    (async (input: {
      userId: string;
      groupId: string;
      depsFor: (run: { workspaceId: string | null }) => ImportBuildDeps;
    }) => (await import("./build.js")).buildLibraryGroup(input));
  const ops = curateOpsOf(args.ops);
  const curated = ops.length
    ? await curate({ userId: args.ownerUserId, ops })
    : null;
  const builds: LibraryOrganizeApplied["builds"] = [];
  for (const op of args.ops) {
    if (op.op !== "group.build") continue;
    builds.push({
      groupId: op.groupId,
      result: await build({
        userId: args.ownerUserId,
        groupId: op.groupId,
        depsFor: args.depsFor,
      }),
    });
  }
  return { curate: curated, builds };
}

/** True when this organise proposal was already approved (an approve retried). */
export async function organizeProposalApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await defaultDb
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Flip the organise proposal APPROVED once its ops have been applied. */
export async function markOrganizeProposalApproved(
  proposalId: string,
  approverUserId: string
): Promise<void> {
  await defaultDb
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: approverUserId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposalId));
}
