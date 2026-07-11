/**
 * Hub REST — Packages (unified template provisioning)
 *
 * ONE endpoint that provisions a complete workspace from a PackageDefinition:
 * workspace (Phase 1) + capabilities, automations, playbooks, loops (Phase 2).
 * Each layer delegates to its existing canonical service — pure composition.
 */

import { z } from "zod";
import type { HubHono } from "./_shared.js";
import { createWorkspaceFromDefinitionIdempotent } from "../../../services/workspace-creation-service.js";
import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "../../../services/capabilities/create-from-definition.js";
import { createLoopFromDefinition } from "../../../services/loops/create-from-definition.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { auditLog } from "../../../utils/audit-log.js";
import { createHubProtocolCallerContext } from "../utils.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ParamSpecSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "entity", "choice", "boolean"]),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

const CapabilitySchema = z.object({
  templateKey: z.string().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const AutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  triggerType: z.enum(["event", "cron", "webhook", "manual"]),
  triggerConfig: z.record(z.string(), z.unknown()).default({}),
  flowDefinition: z
    .object({
      nodes: z.array(z.record(z.string(), z.unknown())),
      edges: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
  status: z.enum(["draft", "active", "paused"]).default("active"),
});

const PlaybookSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string(),
  params: z.array(ParamSpecSchema).optional(),
  executor: z
    .enum(["is-agent", "external-agent", "hybrid"])
    .default("is-agent"),
  inputStrategy: z.record(z.string(), z.unknown()).optional(),
  channelSpec: z.record(z.string(), z.unknown()).optional(),
  schedule: z.unknown().optional(),
  grants: z.array(z.string()).optional(),
  status: z.enum(["draft", "active", "paused"]).default("active"),
});

const LoopSchema = z.object({
  templateKey: z.string().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const PackageApplySchema = z.object({
  _meta: z
    .object({
      slug: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      version: z.string().optional(),
    })
    .optional(),
  // Workspace fields — passthrough to WorkspaceDefinitionInput
  workspaceName: z.string().optional(),
  description: z.string().optional(),
  workspaceType: z
    .enum(["personal", "agent", "project", "operational"])
    .optional(),
  workspaceSubtype: z.string().optional(),
  /**
   * Optional project to link this workspace's seed entities to. When provided,
   * every seed entity is stamped `belongs_to_project` so the project lens sees
   * the workspace's data. This is what unifies an Agent OS under one project.
   */
  projectId: z.string().uuid().optional(),
  workspaceVisibility: z
    .enum(["private", "members", "pod_visible", "pod_joinable", "public_link"])
    .optional(),
  workspaceCapabilities: z.array(z.string()).optional(),
  sourceRoles: z
    .record(z.string(), z.enum(["provider", "consumer", "provider-consumer"]))
    .optional(),
  defaultSources: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  profiles: z.array(z.record(z.string(), z.unknown())).optional(),
  views: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedEntities: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedRelations: z.array(z.record(z.string(), z.unknown())).optional(),
  displayTemplates: z.array(z.record(z.string(), z.unknown())).optional(),
  entityLinks: z.array(z.record(z.string(), z.unknown())).optional(),
  bentoLayout: z.array(z.record(z.string(), z.unknown())).optional(),
  profileEntityBentoTemplates: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  layoutConfig: z.record(z.string(), z.unknown()).optional(),
  onboarding: z.record(z.string(), z.unknown()).optional(),
  extends: z
    .array(
      z.object({
        source: z.string(),
        import: z
          .object({
            profiles: z.array(z.string()).optional(),
            views: z.array(z.string()).optional(),
          })
          .optional(),
      })
    )
    .optional(),
  // Phase 2 layers
  capabilities: z.array(CapabilitySchema).optional(),
  automations: z.array(AutomationSchema).optional(),
  playbooks: z.array(PlaybookSchema).optional(),
  loops: z.array(LoopSchema).optional(),
});

// ─── Route registration ──────────────────────────────────────────────────────

export function registerPackagesRoutes(app: HubHono): void {
  // The hub app is mounted at /api/hub, so routes are registered RELATIVE
  // (like every sibling: /workspaces, /capabilities). An absolute
  // "/api/hub/packages/apply" here double-prefixes to /api/hub/api/hub/... and 404s.
  app.post("/packages/apply", async (c) => {
    const userId = c.get("userId");
    const agentUserId = c.get("agentUserId") ?? undefined;
    const body = PackageApplySchema.parse(await c.req.json());
    const result: Record<string, unknown> = {};

    // ── Permission check ──────────────────────────────────────────────────
    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "workspace",
      action: "create",
      data: { name: body.workspaceName ?? body._meta?.slug ?? "untitled" },
    });
    if ("denied" in perm && perm.denied)
      return c.json({ error: perm.reason }, 403);
    if ("proposalId" in perm)
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);

    // ── Step 1: Create workspace ──────────────────────────────────────────
    let workspaceId: string | undefined;
    try {
      const ws = await createWorkspaceFromDefinitionIdempotent({
        definition: body as any,
        userId,
        proposalId: body._meta?.slug ?? undefined,
        workspaceName: body.workspaceName,
        templateId: body._meta?.slug ?? undefined,
        packageSlug: body._meta?.slug,
        workspaceType: body.workspaceType,
      });
      workspaceId = ws.workspaceId;
      result.workspace = { status: "created", workspaceId };
      auditLog({
        subjectType: "workspace",
        subjectId: workspaceId,
        action: "create",
        phase: "completed",
        userId,
        data: { templateSlug: body._meta?.slug },
      });
    } catch (e) {
      return c.json(
        { error: "Workspace creation failed", detail: (e as Error).message },
        500
      );
    }

    // ── Step 1b: Enroll the acting agent as a member of the workspace it just
    // provisioned ─────────────────────────────────────────────────────────
    // The hub key resolves to userId = the human owner (linkedUserId) and
    // agentUserId = the agent user (key owner). createWorkspaceFromDefinition
    // adds ONLY the human as owner/admin — the agent gets no member row. Without
    // this, the agent's immediate onboarding writes (POST /api/hub/entities)
    // fail the workspace-membership RBAC in checkPermissionOrPropose, which
    // routes every write into a single deduped, contentless `workspace.join`
    // proposal and DROPS the entity content. Enrolling the agent here (idempotent)
    // lets those writes flow through as normal per-entity governance proposals.
    //
    // Role mirrors the canonical agent-membership logic (channels.ts): "owner"
    // in agent-governed workspaces, "editor" elsewhere.
    //
    // SECURITY: only enrolls into the brand-new workspace this agent just
    // provisioned for its own linked operator (userId owns it) — never a
    // pre-existing workspace, so it can never broaden access. agentUserId is the
    // authenticated key owner (set by the hub auth middleware), and we re-verify
    // it is a real agent user before inserting.
    if (agentUserId && workspaceId) {
      try {
        // Role mirrors the canonical agent-membership logic: "owner" in
        // agent-governed workspaces, "editor" elsewhere.
        const { db, workspaces, eq } = await import("@synap/database");
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        const governanceMode = (
          ws?.settings as { governanceMode?: string } | undefined
        )?.governanceMode;
        const role = governanceMode === "agent-owned" ? "owner" : "editor";
        const { enrollAgentInWorkspace } =
          await import("../../../services/enroll-agent-in-workspace.js");
        result.agentMembership = await enrollAgentInWorkspace({
          workspaceId,
          agentUserId,
          role,
        });
      } catch (e) {
        // Non-fatal: onboarding writes would fall back to a join proposal, but
        // the workspace itself was created successfully.
        result.agentMembership = {
          status: "error",
          message: (e as Error).message,
        };
      }
    }

    const ctx = await createHubProtocolCallerContext(
      userId,
      c.get("scopes") ?? [],
      workspaceId,
      agentUserId
    );

    // ── Step 2: Capabilities ──────────────────────────────────────────────
    if (body.capabilities?.length) {
      const caps: unknown[] = [];
      for (const cap of body.capabilities) {
        try {
          // Resolve a templateKey to its full CapabilityDefinition (DB-first,
          // file fallback) — createCapabilityFromDefinition needs a full def,
          // not a bare {key} stub. Mirrors the /capabilities/apply route.
          const definition =
            cap.definition ??
            (cap.templateKey
              ? await loadCapabilityTemplate(cap.templateKey, { workspaceId })
              : undefined);
          if (!definition) {
            caps.push({
              key: cap.templateKey ?? "inline",
              status: "error",
              message:
                "capability requires a definition or a valid templateKey",
            });
            continue;
          }
          const r = await createCapabilityFromDefinition(
            definition as any,
            cap.params ?? {},
            ctx
          );
          caps.push({
            key: r.capabilityKey,
            status: "created",
            created: r.created,
          });
        } catch (e) {
          caps.push({
            key: cap.templateKey ?? "inline",
            status: "error",
            message: (e as Error).message,
          });
        }
      }
      result.capabilities = caps;
    }

    // ── Step 3: Automations ───────────────────────────────────────────────
    if (body.automations?.length) {
      const { automationsRouter } = await import("../../automations.js");
      const caller = automationsRouter.createCaller(ctx as never);
      const autos: unknown[] = [];
      for (const a of body.automations) {
        try {
          const r = await caller.create({
            workspaceId,
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig: a.triggerConfig,
            flowDefinition: a.flowDefinition ?? { nodes: [], edges: [] },
            status: a.status,
            agentUserId,
            // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
            source: "intelligence",
          } as any);
          autos.push({ name: a.name, status: "created", id: (r as any).id });
        } catch (e) {
          autos.push({
            name: a.name,
            status: "error",
            message: (e as Error).message,
          });
        }
      }
      result.automations = autos;
    }

    // ── Step 4: Playbooks ─────────────────────────────────────────────────
    if (body.playbooks?.length) {
      const { playbooksRouter } = await import("../../playbooks.js");
      const caller = playbooksRouter.createCaller(ctx as never);
      const pbs: unknown[] = [];
      for (const p of body.playbooks) {
        try {
          const r = await caller.create({
            name: p.name,
            description: p.description,
            goalTemplate: p.goalTemplate,
            params: p.params as any,
            executor: p.executor,
            inputStrategy: p.inputStrategy as any,
            channelSpec: p.channelSpec as any,
            schedule: p.schedule,
            status: p.status,
            agentUserId,
            // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
            source: "intelligence",
          } as any);
          pbs.push({
            name: p.name,
            status: (r as any).status,
            playbookId: (r as any).playbook?.id,
            proposalId: (r as any).proposalId,
          });
        } catch (e) {
          pbs.push({
            name: p.name,
            status: "error",
            message: (e as Error).message,
          });
        }
      }
      result.playbooks = pbs;
    }

    // ── Step 5: Loops ─────────────────────────────────────────────────────
    if (body.loops?.length) {
      const loops: unknown[] = [];
      for (const loop of body.loops) {
        try {
          const r = await createLoopFromDefinition(
            (loop.definition ?? { key: loop.templateKey }) as any,
            loop.params ?? {},
            ctx
          );
          loops.push({ key: r.loopKey, status: "created", created: r.created });
        } catch (e) {
          loops.push({
            key: loop.templateKey ?? "inline",
            status: "error",
            message: (e as Error).message,
          });
        }
      }
      result.loops = loops;
    }

    // ── Step 6: Link workspace entities to the project ────────────────────
    // When a projectId is supplied (e.g. by `synap launch agent-os`), stamp
    // every seed entity in the new workspace with `belongs_to_project` so the
    // project lens unifies the workspace's data. Idempotent (unique index).
    if (body.projectId && workspaceId) {
      try {
        const { db, entities, eq, linkEntityToProject } =
          await import("@synap/database");
        const rows = await db
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.workspaceId, workspaceId));
        let linked = 0;
        for (const row of rows) {
          await linkEntityToProject(db, {
            entityId: row.id,
            projectId: body.projectId,
            userId,
            workspaceId,
          });
          linked++;
        }
        result.projectLink = {
          status: "linked",
          projectId: body.projectId,
          entities: linked,
        };
      } catch (e) {
        result.projectLink = { status: "error", message: (e as Error).message };
      }
    }

    return c.json(result, 201);
  });
}
