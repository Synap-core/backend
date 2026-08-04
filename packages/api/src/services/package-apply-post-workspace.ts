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
import { createLinks } from "./links/links-service.js";
import { createHubProtocolCallerContext } from "../routers/hub-protocol/utils.js";
import {
  installCellFromDefinition,
  type PackageCellDefinition,
} from "./cells/install-cell-from-definition.js";
import type { WorkspaceSettings } from "@synap/database";

/**
 * Resolve a playbook's authored `grants` (tool/skill NAMES — see
 * `PackagePostWorkspaceBody.playbooks[].grants`) into `{kind, id}` pairs,
 * matching the same NAME-in-scope lookup `createCapabilityFromDefinition` uses
 * to resolve a skill's `requires` (tool names → ids): workspace-scoped first,
 * falling back to a pod-wide (workspaceId NULL) row. A name that resolves to
 * neither a tool nor a skill is dropped rather than throwing — mirrors the
 * per-item isolation the sibling loops/capabilities appliers use.
 */
async function resolveGrantRefs(
  grants: string[],
  workspaceId: string
): Promise<{ kind: "tool" | "skill"; id: string }[]> {
  if (grants.length === 0) return [];
  const {
    db,
    and,
    eq,
    isNull,
    or,
    drizzleSql,
    tools: toolsTable,
    skills: skillsTable,
  } = await import("@synap/database");
  const resolved: { kind: "tool" | "skill"; id: string }[] = [];
  for (const name of grants) {
    // When the name exists both workspace-scoped and pod-wide, the workspace
    // row must win deterministically (false < true in Postgres ASC, so
    // "workspaceId IS NULL" sorts workspace rows first).
    const [tool] = await db
      .select({ id: toolsTable.id })
      .from(toolsTable)
      .where(
        and(
          eq(toolsTable.name, name),
          or(
            eq(toolsTable.workspaceId, workspaceId),
            isNull(toolsTable.workspaceId)
          )
        )
      )
      .orderBy(drizzleSql`${toolsTable.workspaceId} IS NULL`)
      .limit(1);
    if (tool) {
      resolved.push({ kind: "tool", id: tool.id });
      continue;
    }
    const [skill] = await db
      .select({ id: skillsTable.id })
      .from(skillsTable)
      .where(
        and(
          eq(skillsTable.name, name),
          or(
            eq(skillsTable.workspaceId, workspaceId),
            isNull(skillsTable.workspaceId)
          )
        )
      )
      .orderBy(drizzleSql`${skillsTable.workspaceId} IS NULL`)
      .limit(1);
    if (skill) resolved.push({ kind: "skill", id: skill.id });
    // else: unresolved grant ref — skipped, not fatal (name may not exist yet).
  }
  return resolved;
}

/**
 * Materialize a playbook's `grants` as `playbook --grants--> {tool|skill}` link
 * edges — the same shape `createLoopFromDefinition` writes for a loop
 * template's playbooks. `createLinks` is idempotent on the unique edge
 * (from_type, from_id, to_type, to_id, link_type), so calling this on BOTH the
 * newly-created AND the reused-playbook path never duplicates an edge.
 */
async function grantPlaybookLinks(
  playbookId: string,
  grants: string[] | undefined,
  workspaceId: string
): Promise<void> {
  if (!grants || grants.length === 0) return;
  const refs = await resolveGrantRefs(grants, workspaceId);
  if (refs.length === 0) return;
  await createLinks(
    refs.map((r) => ({
      workspaceId,
      fromType: "playbook" as const,
      fromId: playbookId,
      toType: r.kind,
      toId: r.id,
      linkType: "grants" as const,
      metadata: {},
    }))
  );
}

/**
 * A template-declared action on an entity-detail surface. Authored on a
 * template as `settings.actionPlacements` (see `TemplateActionPlacement` in
 * `@synap-core/workspace-templates`); merged into `workspace.settings` here and
 * read by the browser entity-detail cell to render dynamic actions.
 *
 * `ref` is authored as a capability verb key, or a playbook / automation NAME;
 * `resolveActionPlacementRefs` rewrites playbook/automation names → row ids so
 * the browser can launch them directly. Capability refs pass through unchanged.
 */
export interface ActionPlacement {
  profileSlug: string;
  surface: string;
  kind: "capability" | "playbook" | "automation";
  ref: string;
  label: string;
  when?: {
    requiredFacetSlugs?: string[];
    propertyEquals?: Record<string, unknown>;
    propertyAnyEquals?: Record<string, unknown[]>;
    propertyNotEquals?: Record<string, unknown>;
  };
  confirmation?: {
    title: string;
    description?: string;
    confirmLabel?: string;
  };
}

/**
 * Resolve each placement's `ref` for the browser: playbook/automation NAMES →
 * row ids (workspace-scoped, the same NAME-in-scope lookup the playbooks/
 * automations reuse-checks above use); capability refs (verb keys) pass through.
 * A declared playbook/automation ref must resolve. Otherwise the template is
 * incomplete and installation/reconciliation fails rather than caching a CRM
 * workspace whose primary action silently disappeared.
 */
async function resolveActionPlacementRefs(
  placements: ActionPlacement[],
  workspaceId: string
): Promise<ActionPlacement[]> {
  if (placements.length === 0) return [];
  const {
    db,
    and,
    eq,
    ne,
    asc,
    drizzleSql,
    playbooks: playbooksTable,
    automations: automationsTable,
  } = await import("@synap/database");
  const resolved: ActionPlacement[] = [];
  for (const p of placements) {
    if (p.kind === "capability") {
      // Verb key — stable, resolved by executeCapability at click time.
      resolved.push(p);
      continue;
    }
    if (p.kind === "playbook") {
      const [row] = await db
        .select({ id: playbooksTable.id })
        .from(playbooksTable)
        .where(
          and(
            drizzleSql`lower(${playbooksTable.name}) = lower(${p.ref})`,
            eq(playbooksTable.workspaceId, workspaceId),
            ne(playbooksTable.status, "archived")
          )
        )
        .orderBy(asc(playbooksTable.createdAt), asc(playbooksTable.id))
        .limit(1);
      if (!row)
        throw new Error(
          `Action placement references missing playbook "${p.ref}"`
        );
      resolved.push({ ...p, ref: row.id });
      continue;
    }
    if (p.kind === "automation") {
      const [row] = await db
        .select({ id: automationsTable.id })
        .from(automationsTable)
        .where(
          and(
            eq(automationsTable.name, p.ref),
            eq(automationsTable.workspaceId, workspaceId)
          )
        )
        .limit(1);
      if (!row)
        throw new Error(
          `Action placement references missing automation "${p.ref}"`
        );
      resolved.push({ ...p, ref: row.id });
      continue;
    }
  }
  return resolved;
}

/** Stable identity of a placement — the idempotency key for the settings merge. */
function placementKey(p: ActionPlacement): string {
  // Ref is the durable action identity. Applicability/copy are mutable
  // presentation policy and should be refreshed on reconcile, not duplicated.
  return `${p.profileSlug}::${p.surface}::${p.kind}::${p.ref}`;
}

/** Minimal body slice the post-workspace layers read (PackageApply body). */
export interface PackagePostWorkspaceBody {
  capabilities?: Array<{
    templateKey?: string;
    definition?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }>;
  automations?: Array<{
    key?: string;
    name: string;
    description?: string;
    triggerType: "event" | "cron" | "webhook" | "manual";
    triggerConfig: Record<string, unknown>;
    flowDefinition?: {
      nodes: unknown[];
      edges: unknown[];
      precondition?: string;
    };
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
    /**
     * Free-form playbook metadata → `playbooks.metadata`. Carries the propose-only
     * governance marker for unattended maintenance playbooks
     * (`{ governance: { forceProposeWrites: true } }`).
     */
    metadata?: Record<string, unknown>;
    status?: string;
  }>;
  loops?: Array<{
    templateKey?: string;
    definition?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }>;
  /**
   * Inline cell (view-renderer) definitions carried by the package. Installed
   * through the shared `installCellFromDefinition` → `defineCell` door — the
   * SAME mapping `market.install({kind:"cell"})` uses, so a cell installed via
   * either door lands on the same `cell:<package>:<key>` row.
   */
  cells?: PackageCellDefinition[];
  /**
   * Package identity — namespaces the installed cells' typeKeys. Present on the
   * `/packages/apply` body; the approve-executor path passes the stored
   * definition, which carries it too.
   */
  _meta?: { slug?: string };
  /**
   * Entity-detail action placements to merge into `settings.actionPlacements`.
   * Applied AFTER playbooks/loops so playbook/automation refs resolve to the
   * rows this apply just created. See {@link ActionPlacement}.
   */
  actionPlacements?: ActionPlacement[];
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

/**
 * Stamp the workspace `provisioningStatus:"failed"` after a post-workspace
 * layer throw. Routes through `mergeSettings` — the ONE door provisioning-status
 * transitions flow through — mirroring core's `handleStepError`. Best-effort:
 * a stamp failure must never mask the real layer error.
 */
async function markPostWorkspaceProvisioningFailed(
  workspaceId: string,
  userId: string,
  cause: unknown
): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const { getDb, WorkspaceRepository, eventRepository } =
    await import("@synap/database");
  const dbConn = await getDb();
  const repo = new WorkspaceRepository(dbConn, eventRepository);
  await repo.mergeSettings(
    workspaceId,
    {
      provisioningStatus: "failed",
      failedStep: "post-workspace",
      failedStepError: message.slice(0, 500),
    },
    userId
  );
}

/**
 * Public door. The core engine stamps `provisioningStatus:"active"` +
 * `packageVersion` BEFORE this runs, so a bare throw here would leave the
 * workspace "active" with its living layers (capabilities/playbooks/automations/
 * loops) missing — and a same-version reinstall then sees `outcome:"unchanged"`
 * and PERMANENTLY skips re-seeding (`packages.ts` gate). Stamping "failed" on
 * throw makes the next reinstall re-enter `resumeIfFailed` → core resumes →
 * `outcome:"created"` → this door re-runs. Re-running is safe: every layer
 * applier here is idempotent (capabilities/automations/playbooks dedup by name;
 * `createLinks` dedups by unique edge). Recovery for the "living operation"
 * layer The Arch / Enterprise-OS depend on.
 */
export async function applyPackagePostWorkspace(
  input: ApplyPackagePostWorkspaceInput
): Promise<Record<string, unknown>> {
  try {
    return await applyPackagePostWorkspaceInner(input);
  } catch (e) {
    await markPostWorkspaceProvisioningFailed(
      input.workspaceId,
      input.userId,
      e
    ).catch(() => {});
    throw e;
  }
}

async function applyPackagePostWorkspaceInner(
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
    // sourceMessageId + sessionId are not applicable here; `agentUserId` is the
    // 6th positional arg. Passing it in the 4th slot (a prior bug) nulled
    // ctx.agentUserId, so the loop layer's playbooks/automations materialized
    // with agentUserId=undefined → checkPermissionOrPropose auto-applied for an
    // AGENT install instead of proposing (a governance-membrane bypass). The
    // acting agent identity must reach the shared door's caller context.
    undefined,
    undefined,
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
      or,
      eq,
      isNull,
      drizzleSql,
      automations: automationsTable,
    } = await import("@synap/database");
    const caller = automationsRouter.createCaller(ctx as never);
    const autos: unknown[] = [];
    for (const a of body.automations) {
      try {
        const [existing] = await db
          .select({
            id: automationsTable.id,
            metadata: automationsTable.metadata,
          })
          .from(automationsTable)
          .where(
            and(
              a.key
                ? or(
                    eq(automationsTable.name, a.name),
                    drizzleSql`${automationsTable.metadata}->>'templateKey' = ${a.key}`
                  )
                : eq(automationsTable.name, a.name),
              workspaceId
                ? eq(automationsTable.workspaceId, workspaceId)
                : isNull(automationsTable.workspaceId)
            )
          )
          .limit(1);
        if (existing) {
          // Template definitions are declarative ownership, not a one-time
          // seed. Reconcile refreshes the same workflow row so a pod never
          // silently keeps an obsolete graph after a template upgrade.
          await caller.update({
            id: existing.id,
            workspaceId,
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig: a.triggerConfig,
            flowDefinition: a.flowDefinition ?? { nodes: [], edges: [] },
            status: a.status,
            metadata: a.key
              ? { ...(existing.metadata ?? {}), templateKey: a.key }
              : undefined,
          } as never);
          autos.push({ name: a.name, status: "updated", id: existing.id });
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
          metadata: a.key ? { templateKey: a.key } : undefined,
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
    // Per-item isolation: an automation that fails to apply is reported as
    // {status:"error"} in `autos` and does NOT abort the package's independent
    // downstream steps (playbooks/loops/links below). Removing the previous
    // throw here converges this door onto the partial-install-with-warnings
    // pattern used by createCapabilityFromDefinition and market.install.
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
          // Match playbooks_workspace_name_active_uq (0227): case-insensitive,
          // non-archived, oldest-wins. create's 23505 recovery closes the race.
          const { ne, asc, drizzleSql } = await import("@synap/database");
          const [existing] = await db
            .select({ id: playbooksTable.id })
            .from(playbooksTable)
            .where(
              and(
                drizzleSql`lower(${playbooksTable.name}) = lower(${p.name})`,
                eq(playbooksTable.workspaceId, workspaceId),
                ne(playbooksTable.status, "archived")
              )
            )
            .orderBy(asc(playbooksTable.createdAt), asc(playbooksTable.id))
            .limit(1);
          if (existing) {
            // Reuse still ensures grants idempotently — a re-applied package
            // must not leave a pre-existing playbook's grants unwired.
            await grantPlaybookLinks(existing.id, p.grants, workspaceId);
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
          // Propose-only governance marker (maintenance playbooks) → playbooks.metadata.
          metadata: p.metadata as never,
          status: p.status,
          agentUserId,
          source: "intelligence",
        } as never);
        // `playbooksRouter.create` does not accept/materialize grants — they
        // become `playbook --grants--> {tool|skill}` link edges via
        // `createLinks`, exactly as `createLoopFromDefinition` (loops door)
        // does in its own step. Only wire them when the playbook actually got
        // an id (a proposed/governed-deferred playbook has none yet).
        const rr = r as {
          status?: string;
          playbook?: { id?: string };
          proposalId?: string;
        };
        if (rr.playbook?.id) {
          await grantPlaybookLinks(rr.playbook.id, p.grants, workspaceId);
        }
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
    const failed = loops.find(
      (entry) => (entry as { status?: string }).status === "error"
    );
    if (failed) {
      throw new Error(
        `Failed to apply a loop: ${(failed as { message?: string }).message ?? "unknown error"}`
      );
    }
    result.loops = loops;
  }

  // ── Cells (view renderers shipped by the package) ───────────────────────
  // A renderer IS a cell package declaring `viewTypes`; that chain was intact
  // for `market.install({kind:"cell"})` and dead for a WORKSPACE package's
  // inline `cells[]` — the schema stripped the field, so nothing ever reached
  // an applier. Installed workspace-scoped (this install owns them), through
  // the same door market.install uses.
  //
  // Per-item isolation, like capabilities/automations above: a bad cell is
  // reported as {status:"error"} and never aborts the independent steps below.
  // `defineCell` is an idempotent upsert on (typeKey, workspaceId), so a
  // re-apply converges instead of duplicating.
  if (body.cells?.length && workspaceId) {
    // NO `?? "inline"` FALLBACK. The typeKey is `cell:<packageSlug>:<key>`, and
    // `defineCell`'s idempotent upsert keys on it — so a package applied once
    // WITHOUT `_meta.slug` and once WITH it would mint TWO rows for the same
    // cell, which the upsert can never reconcile because the keys differ. That
    // silently defeats the convergence guarantee `installCellFromDefinition`
    // exists to provide. An un-namespaceable cell is an error, per item, using
    // the same isolation as every other step here.
    const packageSlug = body._meta?.slug;
    const cellResults: unknown[] = [];
    for (const cell of body.cells) {
      if (!packageSlug) {
        cellResults.push({
          key: cell.key ?? "inline",
          status: "error",
          message:
            "package cells require _meta.slug to namespace their typeKey; " +
            "applying without it would create a duplicate renderer row",
        });
        continue;
      }
      try {
        const r = await installCellFromDefinition({
          definition: cell,
          name: cell.name ?? cell.key ?? "Cell",
          packageSlug,
          cellKey: cell.key,
          workspaceId,
          userId,
        });
        cellResults.push({
          key: cell.key,
          status: r.changeType,
          typeKey: r.typeKey,
        });
      } catch (e) {
        cellResults.push({
          key: cell.key ?? "inline",
          status: "error",
          message: (e as Error).message,
        });
      }
    }
    result.cells = cellResults;
  }

  // ── Action placements (→ settings.actionPlacements) ─────────────────────
  // Runs AFTER playbooks/loops so playbook/automation refs resolve to rows this
  // apply created. Merged idempotently into the workspace settings JSONB (dedup
  // on profileSlug+surface+kind+ref) via the same direct read-modify-write the
  // enroll-agent step / workspace-creation-service proposalId-stamp use — not
  // the governed tRPC settings caller, which would PROPOSE (not apply) an
  // agent-driven settings change and leave placements deferred.
  // KNOWN LIMIT: read-modify-write has a lost-update window if a concurrent
  // writer touches settings between the SELECT and UPDATE (second install,
  // enroll-agent, user edit). Accepted — installs are rare and re-apply is
  // idempotent (re-running restores a lost placement); a server-side JSONB
  // merge is the fix if this ever bites.
  if (body.actionPlacements?.length && workspaceId) {
    try {
      const resolved = await resolveActionPlacementRefs(
        body.actionPlacements,
        workspaceId
      );
      if (resolved.length > 0) {
        const { db, workspaces, eq } = await import("@synap/database");
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        const existingSettings = (ws?.settings ?? {}) as Record<
          string,
          unknown
        >;
        const existingPlacements = Array.isArray(
          existingSettings.actionPlacements
        )
          ? (existingSettings.actionPlacements as ActionPlacement[])
          : [];
        const merged = [...existingPlacements];
        const indexByKey = new Map(
          merged.map((placement, index) => [placementKey(placement), index])
        );
        for (const p of resolved) {
          const key = placementKey(p);
          const existingIndex = indexByKey.get(key);
          if (existingIndex === undefined) {
            indexByKey.set(key, merged.length);
            merged.push(p);
          } else {
            // Reconcile is declarative: the latest template is authoritative
            // for applicability/confirmation/copy of its stable action key.
            merged[existingIndex] = p;
          }
        }
        await db
          .update(workspaces)
          .set({
            settings: {
              ...existingSettings,
              actionPlacements: merged,
            } as WorkspaceSettings,
          })
          .where(eq(workspaces.id, workspaceId));
        result.actionPlacements = {
          status: "merged",
          count: resolved.length,
          total: merged.length,
        };
      } else {
        result.actionPlacements = { status: "skipped", count: 0 };
      }
    } catch (e) {
      throw new Error(
        `Failed to apply action placements: ${(e as Error).message}`
      );
    }
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
