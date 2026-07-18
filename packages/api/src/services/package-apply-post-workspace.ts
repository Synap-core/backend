/**
 * Package apply — post-workspace layers (ONE door for grant + approve).
 *
 * After a workspace exists (materializeWorkspaceCore / create path), both:
 *   - Hub POST /packages/apply (operator grant path)
 *   - proposals approve executor for workspace/create (agent propose → human approve)
 * must run the same steps so agent package install is never a silent partial.
 *
 * Steps: enroll acting agent → capabilities → automations → playbooks → loops
 * → optional project entity links.
 */

import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "./capabilities/create-from-definition.js";
import { createLoopFromDefinition } from "./loops/create-from-definition.js";
import { createHubProtocolCallerContext } from "../routers/hub-protocol/utils.js";

/** Minimal body slice the post-workspace layers read (PackageApply body). */
export interface PackagePostWorkspaceBody {
  capabilities?: Array<{
    templateKey?: string;
    definition?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }>;
  automations?: Array<{
    name: string;
    description?: string;
    triggerType: "event" | "cron" | "webhook" | "manual";
    triggerConfig: Record<string, unknown>;
    flowDefinition?: { nodes: unknown[]; edges: unknown[] };
    status?: string;
  }>;
  playbooks?: Array<{
    name: string;
    description?: string;
    goalTemplate?: string;
    params?: unknown;
    executor?: unknown;
    inputStrategy?: unknown;
    channelSpec?: unknown;
    schedule?: unknown;
    /**
     * Entity kind the playbook operates over → persisted to
     * `playbooks.subject_profile` (forwarded to `playbooksRouter.create` below),
     * making it matchable by `playbooks.matchForEntity`.
     */
    subjectProfile?: { profileSlug: string; filter?: Record<string, unknown> };
    /** tool/skill keys this playbook grants (see materialization note below). */
    grants?: string[];
    status?: string;
  }>;
  loops?: Array<{
    templateKey?: string;
    definition?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }>;
  projectId?: string;
}

export interface ApplyPackagePostWorkspaceInput {
  workspaceId: string;
  body: PackagePostWorkspaceBody;
  userId: string;
  agentUserId?: string;
  /** Hub API scopes; approve path may pass []. */
  scopes?: string[];
}

export async function applyPackagePostWorkspace(
  input: ApplyPackagePostWorkspaceInput
): Promise<Record<string, unknown>> {
  const { workspaceId, body, userId, agentUserId } = input;
  const scopes = input.scopes ?? [];
  const result: Record<string, unknown> = {};

  // ── Enroll acting agent ─────────────────────────────────────────────────
  // createWorkspaceFromDefinition adds ONLY the human owner. Without this,
  // the agent's follow-on writes collapse into contentless workspace.join
  // proposals. Idempotent; only for the brand-new workspace this apply owns.
  if (agentUserId) {
    try {
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
        await import("./enroll-agent-in-workspace.js");
      result.agentMembership = await enrollAgentInWorkspace({
        workspaceId,
        agentUserId,
        role,
      });
    } catch (e) {
      result.agentMembership = {
        status: "error",
        message: (e as Error).message,
      };
    }
  }

  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    workspaceId,
    agentUserId
  );

  // ── Capabilities ────────────────────────────────────────────────────────
  if (body.capabilities?.length) {
    const caps: unknown[] = [];
    for (const cap of body.capabilities) {
      try {
        const definition =
          cap.definition ??
          (cap.templateKey
            ? await loadCapabilityTemplate(cap.templateKey, { workspaceId })
            : undefined);
        if (!definition) {
          caps.push({
            key: cap.templateKey ?? "inline",
            status: "error",
            message: "capability requires a definition or a valid templateKey",
          });
          continue;
        }
        const r = await createCapabilityFromDefinition(
          definition as Parameters<typeof createCapabilityFromDefinition>[0],
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

  // ── Automations ─────────────────────────────────────────────────────────
  if (body.automations?.length) {
    const { automationsRouter } = await import("../routers/automations.js");
    const {
      db,
      and,
      eq,
      isNull,
      automations: automationsTable,
    } = await import("@synap/database");
    const caller = automationsRouter.createCaller(ctx as never);
    const autos: unknown[] = [];
    for (const a of body.automations) {
      try {
        const [existing] = await db
          .select({ id: automationsTable.id })
          .from(automationsTable)
          .where(
            and(
              eq(automationsTable.name, a.name),
              workspaceId
                ? eq(automationsTable.workspaceId, workspaceId)
                : isNull(automationsTable.workspaceId)
            )
          )
          .limit(1);
        if (existing) {
          autos.push({ name: a.name, status: "reused", id: existing.id });
          continue;
        }
        const r = await caller.create({
          workspaceId,
          name: a.name,
          description: a.description,
          triggerType: a.triggerType,
          triggerConfig: a.triggerConfig,
          flowDefinition: a.flowDefinition ?? { nodes: [], edges: [] },
          status: a.status,
          agentUserId,
          source: "intelligence",
        } as never);
        autos.push({
          name: a.name,
          status: "created",
          id: (r as { id?: string }).id,
        });
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

  // ── Playbooks ───────────────────────────────────────────────────────────
  if (body.playbooks?.length) {
    const { playbooksRouter } = await import("../routers/playbooks.js");
    const {
      db,
      and,
      eq,
      playbooks: playbooksTable,
    } = await import("@synap/database");
    const caller = playbooksRouter.createCaller(ctx as never);
    const pbs: unknown[] = [];
    for (const p of body.playbooks) {
      try {
        if (workspaceId) {
          const [existing] = await db
            .select({ id: playbooksTable.id })
            .from(playbooksTable)
            .where(
              and(
                eq(playbooksTable.name, p.name),
                eq(playbooksTable.workspaceId, workspaceId)
              )
            )
            .limit(1);
          if (existing) {
            pbs.push({
              name: p.name,
              status: "reused",
              playbookId: existing.id,
            });
            continue;
          }
        }
        const r = await caller.create({
          name: p.name,
          description: p.description,
          goalTemplate: p.goalTemplate,
          params: p.params as never,
          executor: p.executor,
          inputStrategy: p.inputStrategy as never,
          channelSpec: p.channelSpec as never,
          schedule: p.schedule,
          // Subject kind → `playbooks.subject_profile`; unlocks matchForEntity.
          subjectProfile: p.subjectProfile as never,
          status: p.status,
          agentUserId,
          source: "intelligence",
        } as never);
        // NOTE: `p.grants` is intentionally NOT forwarded here. `playbooksRouter.create`
        // does not accept/materialize grants — they become `playbook --grants--> {tool|skill}`
        // link edges via `createLinks`, exactly as `createLoopFromDefinition` (loops door)
        // does in its own step. Wiring that link step at this door is a separate follow-up;
        // the type carries `grants` so the data survives to this boundary for it.
        const rr = r as {
          status?: string;
          playbook?: { id?: string };
          proposalId?: string;
        };
        pbs.push({
          name: p.name,
          status: rr.status,
          playbookId: rr.playbook?.id,
          proposalId: rr.proposalId,
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

  // ── Loops ───────────────────────────────────────────────────────────────
  if (body.loops?.length) {
    const loops: unknown[] = [];
    for (const loop of body.loops) {
      try {
        const r = await createLoopFromDefinition(
          (loop.definition ?? {
            key: loop.templateKey,
          }) as unknown as Parameters<typeof createLoopFromDefinition>[0],
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

  // ── Project link (seed entities) ────────────────────────────────────────
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

  return result;
}
