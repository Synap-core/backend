/**
 * Capability Containers router — CRUD for the `capabilities` table.
 *
 * A Capability is a named bundle ("a thing your agents can do"). It groups parts
 * — Connections (tools), Skills, Built-ins — which attach via the polymorphic
 * `links` table as `tool|skill --member_of--> capability`. The container itself
 * executes nothing; each part keeps its own approval/governance.
 *
 * Reads are user-visible-scoped (pod-wide + the caller's workspaces). Writes gate
 * on the LOADED row's workspaceId via `assertWorkspaceWrite`. Part links are
 * written directly against the `links` table using the DB schema types (which
 * carry the `capability` endpoint), so no @synap/playbooks contract change.
 *
 * Mounted at `capabilities.containers.*`. The flat read-model registry
 * (`playbooks.capabilityRegistry.list`) still lists individual tools/skills —
 * used here as the "add an existing part" picker.
 */
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, isNull, inArray, desc } from "@synap/database";
import {
  capabilities,
  tools,
  skills,
  playbooks,
  automations,
  links,
} from "@synap/database/schema";
import type { CapabilityRow } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { uninstallCapability } from "../services/capabilities/uninstall-capability.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

/**
 * A part the user can attach to a capability. Built-ins are tools (kind=builtin).
 *
 * `playbook`/`automation` are MATERIALIZED members — a capability's seeded
 * process flows (`playbook|automation --member_of--> capability`, allowed by the
 * link vocabulary). Without them the "installed capability → what it
 * materialized" edge does not exist in DATA, so the composition map is
 * underivable. The container's count/get read model still groups only
 * tool/skill/builtin; a process member is a valid link that those counts simply
 * don't surface (the map reads the links directly via `getLinksFor`).
 */
const PART_TYPES = ["tool", "skill", "playbook", "automation"] as const;

/** Empty per-group counts. */
function zeroCounts(): {
  connections: number;
  skills: number;
  builtins: number;
} {
  return { connections: 0, skills: 0, builtins: 0 };
}

export const capabilityContainersRouter = router({
  /** Capability containers visible to the caller, each with part counts. */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const ws = input?.workspaceId;
      // A specific workspace only NARROWS (still includes pod-wide NULL rows);
      // no workspace → no narrow, so the user-visible floor below is pod-wide.
      const lens = ws
        ? or(isNull(capabilities.workspaceId), eq(capabilities.workspaceId, ws))
        : undefined;
      const rows = await db
        .select()
        .from(capabilities)
        .where(and(lens, userVisibleWhere(capabilities.workspaceId, userId)))
        .orderBy(desc(capabilities.createdAt));
      if (rows.length === 0) return [];

      const capIds = rows.map((r) => r.id);
      const memberLinks = await db
        .select()
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            inArray(links.toId, capIds),
            eq(links.linkType, "member_of")
          )
        );

      // Resolve tool kinds so builtin parts count separately from connections.
      const toolIds = memberLinks
        .filter((l) => l.fromType === "tool")
        .map((l) => l.fromId);
      const toolKind = new Map<string, string>();
      if (toolIds.length > 0) {
        const ts = await db
          .select({ id: tools.id, kind: tools.kind })
          .from(tools)
          .where(inArray(tools.id, toolIds));
        ts.forEach((t) => toolKind.set(t.id, t.kind));
      }

      const counts = new Map<string, ReturnType<typeof zeroCounts>>();
      capIds.forEach((id) => counts.set(id, zeroCounts()));
      for (const l of memberLinks) {
        const c = counts.get(l.toId);
        if (!c) continue;
        if (l.fromType === "skill") c.skills += 1;
        else if (l.fromType === "tool") {
          if (toolKind.get(l.fromId) === "builtin") c.builtins += 1;
          else c.connections += 1;
        }
      }

      return rows.map((r) => ({
        ...(r as CapabilityRow),
        parts: counts.get(r.id) ?? zeroCounts(),
      }));
    }),

  /** One capability + its parts, grouped for the rail (Connections/Skills/Built-ins). */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [cap] = await db
        .select()
        .from(capabilities)
        .where(
          and(
            eq(capabilities.id, input.id),
            userVisibleWhere(capabilities.workspaceId, userId)
          )
        );
      if (!cap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });

      const memberLinks = await db
        .select()
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.toId, cap.id),
            eq(links.linkType, "member_of")
          )
        );
      const toolIds = memberLinks
        .filter((l) => l.fromType === "tool")
        .map((l) => l.fromId);
      const skillIds = memberLinks
        .filter((l) => l.fromType === "skill")
        .map((l) => l.fromId);

      const toolRows =
        toolIds.length > 0
          ? await db
              .select()
              .from(tools)
              .where(
                and(
                  inArray(tools.id, toolIds),
                  userVisibleWhere(tools.workspaceId, userId)
                )
              )
          : [];
      const skillRows =
        skillIds.length > 0
          ? await db
              .select()
              .from(skills)
              .where(
                and(
                  inArray(skills.id, skillIds),
                  userVisibleWhere(skills.workspaceId, userId)
                )
              )
          : [];

      const part = (
        id: string,
        name: string,
        kind: string,
        approved: boolean | null
      ) => ({ id, name, kind, approved: !!approved });

      return {
        capability: cap as CapabilityRow,
        parts: {
          connections: toolRows
            .filter((t) => t.kind !== "builtin")
            .map((t) => part(t.id, t.name, t.kind, t.approved)),
          builtins: toolRows
            .filter((t) => t.kind === "builtin")
            .map((t) => part(t.id, t.name, t.kind, t.approved)),
          skills: skillRows.map((s) => part(s.id, s.name, s.kind, s.approved)),
        },
      };
    }),

  /** Create a capability container — name is the only thing required to exist. */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId,
        subjectType: "capability",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        data: { name: input.name },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return {
          capability: null as CapabilityRow | null,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };

      const [cap] = await db
        .insert(capabilities)
        .values({
          workspaceId: input.workspaceId ?? null,
          createdBy: input.agentUserId ?? userId,
          name: input.name,
          description: input.description,
        })
        .returning();
      return {
        capability: cap as CapabilityRow,
        status: "created" as const,
        proposalId: null as string | null,
      };
    }),

  /** Edit a capability's config (name · description · approval). */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        approved: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [existing] = await db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, input.id));
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });
      await assertWorkspaceWrite(db, userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });
      const [updated] = await db
        .update(capabilities)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          approved: input.approved ?? existing.approved,
          updatedAt: new Date(),
        })
        .where(eq(capabilities.id, input.id))
        .returning();
      return { capability: updated as CapabilityRow };
    }),

  /** Delete a capability + its part links (the parts themselves are untouched). */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [existing] = await db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, input.id));
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });
      // This path now CASCADES (deletes orphaned member tools/skills), so it
      // must carry the SAME authorization floor as `capabilities.uninstall`:
      // workspace OWNER for a workspace-scoped capability, pod admin for a
      // pod-scoped one — not the weaker editor+ `assertWorkspaceWrite` floor.
      if (existing.workspaceId !== null) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can remove workspace capabilities.",
          });
        }
      } else {
        await requirePodAdmin(userId);
      }
      // Route through the canonical uninstaller so this path CASCADES: it drops
      // the member links, the container, AND any member tools/skills that are
      // left orphaned (not shared with another capability). Previously this
      // procedure only removed the container + links, leaving orphaned tools that
      // could shadow a re-installed capability's pod-wide tool (scope precedence)
      // and break connection-selector resolution. Shared members are preserved.
      const result = await uninstallCapability(input.id, ctx);
      return { ok: true as const, deleted: result.deleted };
    }),

  /** Attach an existing part (tool/skill) to a capability via a member_of link. */
  addPart: protectedProcedure
    .input(
      z.object({
        capabilityId: z.string().uuid(),
        partType: z.enum(PART_TYPES),
        partId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [cap] = await db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, input.capabilityId));
      if (!cap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });
      // FLOOR, beneath the governance gate — not a substitute for it.
      // `checkPermissionOrPropose` performs workspace-membership RBAC ONLY when a
      // workspace lens is present (permission-check.ts: "At pod scope there is no
      // membership to verify"). So a pod-wide container (workspaceId === null)
      // would otherwise be attachable by ANY authenticated pod member, silently
      // changing what someone else's bundle grants. `removePart` never lost this
      // floor — without it you could attach to a container you cannot detach from.
      // Workspace-scoped rows are deliberately NOT gated here: the governance gate
      // already covers them, and double-gating would kill the "agent asks to join"
      // proposal path.
      //
      // The pod floor is OWNER *or* POD ADMIN — the same floor `delete` (above)
      // applies to a pod-scoped container. Owner-only was too narrow in two real
      // cases: an ownership transfer orphans every container the old owner
      // created, and a second pod admin legitimately maintains shared bundles.
      // Re-apply hits this constantly because the installer resolves an existing
      // container by NAME + scope (create-from-definition.ts:918-932), never by
      // creator — so the second installer of a pod-scoped capability is almost
      // never the row's `createdBy`.
      if (cap.workspaceId === null && cap.createdBy !== userId) {
        await requirePodAdmin(userId);
      }

      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: input.agentUserId,
        workspaceId: cap.workspaceId ?? undefined,
        subjectType: "capability",
        action: "attach",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          capabilityId: input.capabilityId,
          partType: input.partType,
          partId: input.partId,
        },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return {
          ok: false as const,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };

      // The part need only be VISIBLE to the caller (read floor), not writable.
      // A Capability is inert — it executes nothing and each part keeps its own
      // `approved` gate — so attaching a pod-wide tool/skill the caller can see
      // is intentional and contained. Gating on write here would wrongly block
      // attaching pod-wide parts (workspaceId=null → owner-only write). The edge
      // is stamped with the CAPABILITY's workspaceId, not the part's; consumers
      // must always re-derive part visibility from the part row (get/list do).
      const partTable =
        input.partType === "tool"
          ? tools
          : input.partType === "skill"
            ? skills
            : input.partType === "playbook"
              ? playbooks
              : automations;
      const [partRow] = await db
        .select({ id: partTable.id })
        .from(partTable)
        .where(
          and(
            eq(partTable.id, input.partId),
            userVisibleWhere(partTable.workspaceId, userId)
          )
        );
      if (!partRow)
        throw new TRPCError({ code: "NOT_FOUND", message: "Part not found" });

      await db
        .insert(links)
        .values({
          workspaceId: cap.workspaceId,
          fromType: input.partType,
          fromId: input.partId,
          toType: "capability",
          toId: cap.id,
          linkType: "member_of",
          metadata: {},
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
      return {
        ok: true as const,
        status: "created" as const,
        proposalId: null as string | null,
      };
    }),

  /** Detach a part from a capability (removes the member_of link only). */
  removePart: protectedProcedure
    .input(
      z.object({
        capabilityId: z.string().uuid(),
        partType: z.enum(PART_TYPES),
        partId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [cap] = await db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, input.capabilityId));
      if (!cap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });
      await assertWorkspaceWrite(db, userId, {
        workspaceId: cap.workspaceId,
        ownerId: cap.createdBy,
      });
      await db
        .delete(links)
        .where(
          and(
            eq(links.fromType, input.partType),
            eq(links.fromId, input.partId),
            eq(links.toType, "capability"),
            eq(links.toId, input.capabilityId),
            eq(links.linkType, "member_of")
          )
        );
      return { ok: true as const };
    }),
});
