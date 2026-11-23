/**
 * rule-loop-callers — the ONE place that builds the composite materializer's
 * Rule Loop (NS1) callers: `skillCaller`, `automationCaller`, `ruleCaller`.
 *
 * MEASURED SEVERANCE: `materializeCompositeGraph` responded to a missing caller
 * with `logger.warn` + `continue` — a SILENT SKIP — and only ONE of its five
 * call sites wired the callers (`routers/proposals/apply-approval.ts`). The
 * other four (`routers/capture.ts`, `services/capture-agent/submit-capture-graph.ts`,
 * and BOTH import-orchestrator materialize paths) wired none. So once a producer
 * emits a `create_skill` / `create_automation` / `create_rule` op, the SAME
 * batch would materialize its config ops when the write happened to be GOVERNED
 * (approval path) and silently drop them when it was AUTO-APPROVED (direct-write
 * path): behaviour forking on governance state, reported as success either way.
 *
 * The fix has two halves and needs both:
 *   1. this factory, so every call site wires the same three callers through
 *      the same canonical doors (there is no second implementation to drift);
 *   2. a FAIL-CLOSED preflight in `materializeCompositeGraph` — a batch carrying
 *      a config op with no matching caller now THROWS before anything is
 *      written, instead of dropping the op and reporting success. A future call
 *      site that forgets to wire cannot re-open the fork silently.
 *
 * Each caller routes to its EXISTING canonical door — `insertSkillGoverned`,
 * `materializeAutomationForPrincipal`, `createRuleGoverned`. They are lazily
 * imported so this module keeps no static edge to the skills / automations
 * routers (both import back into proposals).
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import type {
  SkillCreateCaller,
  AutomationCreateCaller,
  RuleCreateCaller,
  PlaybookCreateCaller,
  ViewCreateCaller,
  CellDefineCaller,
  RendererBindCaller,
  CompositeUpdateCaller,
  WorkspaceCreateCaller,
  KindDefineCaller,
  LifecycleDeclareCaller,
} from "./materialize-composite.js";
import { statusAtCreate } from "@synap-core/types/units";
import { buildCompositeUpdateCaller } from "./composite-update-caller.js";
// Type-only: no runtime edge, so the lazy-import cycle guard above still holds.
import type { materializeAutomationForPrincipal } from "../routers/automations.js";

type AutomationDatabase = Parameters<
  typeof materializeAutomationForPrincipal
>[0]["database"];

export interface RuleLoopCallerContext {
  database: AutomationDatabase;
  /**
   * The principal the writes are attributed to — the approver on the approval
   * path, the capturing/importing user on a direct-write path. Never an agent:
   * the governance decision has ALREADY been made by the time the materializer
   * runs, so these re-entrant doors are passed `agentUserId: undefined` and
   * auto-grant rather than filing a second proposal.
   */
  userId: string;
  /** Owner of the automations it makes: the proposal's subject, else `userId`. */
  ownerUserId?: string | null;
  /** Workspace the materialized config belongs to (null = pod-wide). */
  workspaceId: string | null;
  /** Audit provenance, e.g. "rule_loop_approval" / "rule_loop_capture". */
  auditSource: string;
  /**
   * Who AUTHORED the batch's skills and automations, and whether a person
   * approved it. The writes above run as `userId` with no agent, so the
   * born-approved rule (`skillBornApproved`) and the automation status
   * (`automationStatusAtCreate`) must be told the real author: an agent's
   * skill or automation in a batch that auto-applied (a governance rule, its
   * own space) is born off, exactly as the direct doors leave it. Required,
   * so no call site can forget it: an absent author read as "a trusted human"
   * was the bypass.
   */
  skillAuthor: { agentUserId: string | null; personApproved: boolean };
  /**
   * The proposal being applied, when there is one: stamped on the renderer
   * bindings a `bind_renderer` op writes, as their lineage.
   */
  sourceProposalId?: string;
}

export function buildRuleLoopCallers(ctx: RuleLoopCallerContext): {
  skillCaller: SkillCreateCaller;
  automationCaller: AutomationCreateCaller;
  ruleCaller: RuleCreateCaller;
  playbookCaller: PlaybookCreateCaller;
  viewCaller: ViewCreateCaller;
  cellCaller: CellDefineCaller;
  rendererCaller: RendererBindCaller;
  updateCaller: CompositeUpdateCaller;
  workspaceCaller: WorkspaceCreateCaller;
  kindCaller: KindDefineCaller;
  lifecycleCaller: LifecycleDeclareCaller;
} {
  const { database, userId, workspaceId, auditSource, skillAuthor } = ctx;
  const ownerUserId = ctx.ownerUserId ?? userId;

  // A domain is built only by an approved plan: its rows are the proposal's.
  const domainProposalId = (op: string): string => {
    if (!ctx.sourceProposalId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${op} applies only from an approved plan`,
      });
    }
    return ctx.sourceProposalId;
  };

  return {
    // A domain's SPACE, through the ONE template apply the
    // `synap_create_workspace` door and the `workspace/create` executor run,
    // as the approver. Keyed by the proposal and the op, so a retried
    // approval reuses the space its first attempt made; a space of that name
    // that is somebody else's refuses (one space per domain).
    workspaceCaller: {
      create: async ({ ref, name }) => {
        const proposalId = domainProposalId("create_workspace");
        const idempotencyKey = `${proposalId}:${ref}`;
        const { checkOneSpacePerDomain } =
          await import("../services/workspace-creation-service.js");
        const verdict = await checkOneSpacePerDomain({
          userId,
          idempotencyKey,
          workspaceName: name,
        });
        if (verdict.action === "refuse") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `create_workspace "${name}": a space of this domain already exists`,
          });
        }
        const { applyTemplate } =
          await import("../services/template-apply/index.js");
        const applied = await applyTemplate({
          definition: {} as Parameters<typeof applyTemplate>[0]["definition"],
          actor: { userId },
          source: auditSource,
          identity: {
            proposalId: idempotencyKey,
            workspaceName: name,
            createdBy: "provisioning",
          },
        });
        return {
          id: applied.workspaceId,
          linked: applied.materializeStatus !== "created",
        };
      },
    },

    // A KIND and its fields, through the `profile/create` executor's apply
    // (`materializeKindCreate`), as the approver, owned by the proposal. A
    // kind of that slug already there is linked only when this proposal made
    // it (a retried approval); anybody else's refuses.
    kindCaller: {
      define: async (kindOp) => {
        const proposalId = domainProposalId("define_kind");
        const home = kindOp.workspaceId ?? workspaceId;
        if (!home) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `define_kind "${kindOp.slug}" needs a space: name one (workspaceRef) or file the plan into one`,
          });
        }
        const { checkFieldSpec } =
          await import("../routers/hub-protocol/define-profile.js");
        const checked = kindOp.fields.map(checkFieldSpec);
        const refused = checked.flatMap((c) => ("entry" in c ? [c.entry] : []));
        if (refused.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `define_kind "${kindOp.slug}": ${refused
              .map((e) => `${String(e.slug ?? "field")}: ${String(e.error)}`)
              .join("; ")}`,
          });
        }
        const { slugifyPropertyKey } = await import("@synap/database");
        const { materializeKindCreate } =
          await import("../routers/proposals/executors/profile.js");
        const uiHints = {
          ...(kindOp.icon ? { icon: kindOp.icon } : {}),
          ...(kindOp.description ? { description: kindOp.description } : {}),
        };
        const made = await materializeKindCreate({
          userId,
          workspaceId: home,
          proposalId,
          agentAuthored: !!skillAuthor.agentUserId,
          duplicateReviewed: false,
          profile: {
            slug: slugifyPropertyKey(kindOp.slug) || kindOp.slug,
            displayName: kindOp.displayName,
            profileKind: "kind",
            ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
            ...(kindOp.entityScope ? { entityScope: kindOp.entityScope } : {}),
          },
          kindFields: checked.flatMap((c) => ("field" in c ? [c.field] : [])),
        });
        if (!made.profileId || !made.slug) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `define_kind "${kindOp.slug}" did not apply`,
          });
        }
        if (made.existing && made.existingOwnerId !== proposalId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `define_kind: a kind "${made.slug}" already exists here; approval never adopts it`,
          });
        }
        return { id: made.profileId, slug: made.slug, linked: made.existing };
      },
    },

    // A kind's LIFECYCLE, through the lifecycle declaration's approval half
    // (`applyKindLifecycle`): the preflight and the authority floor re-run on
    // the approver, the field and the declaration in one transaction.
    lifecycleCaller: {
      declare: async (lifecycleOp) => {
        const proposalId = domainProposalId("declare_lifecycle");
        const { applyKindLifecycle } =
          await import("../services/lifecycle/declare-kind-lifecycle.js");
        const applied = await applyKindLifecycle({
          approverUserId: userId,
          sourceProposalId: proposalId,
          input: {
            profileId: lifecycleOp.profileId,
            ...(lifecycleOp.property ? { property: lifecycleOp.property } : {}),
            options: lifecycleOp.options,
            ...(lifecycleOp.initialStatus
              ? { initialStatus: lifecycleOp.initialStatus }
              : {}),
          },
        });
        return { propertyDefId: applied.propertyDefId };
      },
    },

    // A playbook's UI: the generated cell, through the ONE cell door
    // (`defineCell` runs the mount and sandbox checks again on the source
    // the reviewer approved). Never overwrites a cell of the same key that
    // appeared after the proposal was filed: that cell is somebody's.
    cellCaller: {
      define: async (cellOp) => {
        const { defineCell, readStoredCellContent, cellTypeKeyFor } =
          await import("../services/cells/define-cell.js");
        const { CONTENT_KINDS } = await import("@synap/database/schema");
        const contentKind = cellOp.contentKind;
        if (
          contentKind !== undefined &&
          !(CONTENT_KINDS as readonly string[]).includes(contentKind)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `create_cell: "${contentKind}" is not a content kind (${CONTENT_KINDS.join(", ")})`,
          });
        }
        const existing = await readStoredCellContent({
          name: cellOp.name,
          workspaceId: cellOp.workspaceId,
        });
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `create_cell: a cell "${cellTypeKeyFor(cellOp.name)}" already exists here; approval never overwrites it`,
          });
        }
        const defined = await defineCell({
          name: cellOp.name,
          rendererSource: cellOp.rendererSource,
          workspaceId: cellOp.workspaceId,
          ...(cellOp.description ? { description: cellOp.description } : {}),
          ...(contentKind
            ? {
                contentKind: contentKind as (typeof CONTENT_KINDS)[number],
              }
            : {}),
          userId,
        });
        return {
          id: defined.id,
          typeKey: defined.typeKey,
          workspaceId: cellOp.workspaceId,
          created: defined.changeType === "created",
        };
      },
    },

    // …and the one object's page it shows on, through the ONE binding door.
    // A slot that already shows something is refused (named, the batch goes
    // on): approval never replaces a page somebody chose meanwhile.
    rendererCaller: {
      bind: async (bindOp) => {
        const {
          assertCellBindable,
          assertRendererTargetVisible,
          cellRendererRefFor,
          readBoundRenderer,
        } = await import("../services/renderers/renderer-target-checks.js");
        const { setProfileRenderer } =
          await import("../services/profiles/set-profile-renderer.js");
        const { SLOT_TO_CONTENT_KIND } =
          await import("../services/profiles/renderer-slots.js");
        const {
          rendererBindings,
          and: andWhere,
          eq: eqWhere,
          isNull: isNullWhere,
          desc,
        } = await import("@synap/database");
        const target = { kind: bindOp.targetKind, id: bindOp.targetId };
        await assertRendererTargetVisible(target, userId);
        const lensWorkspaceId =
          bindOp.scope === "workspace" ? bindOp.workspaceId : null;
        const incumbent = await readBoundRenderer({
          target,
          slot: bindOp.slot,
          userId,
          workspaceId: lensWorkspaceId,
        });
        if (incumbent) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `bind_renderer: this ${bindOp.targetKind}'s page already shows a renderer (${incumbent.source}); approval never replaces it`,
          });
        }
        await assertCellBindable({
          cellKey: bindOp.cellKey,
          workspaceId: bindOp.workspaceId,
          userId,
        });
        const ref = await cellRendererRefFor(
          bindOp.cellKey,
          undefined,
          bindOp.workspaceId
        );
        await setProfileRenderer({
          userId,
          workspaceId: bindOp.workspaceId,
          profileSlug: bindOp.targetKind,
          subjectId: bindOp.targetId,
          slot: bindOp.slot,
          ref,
          scope: bindOp.scope,
          ...(ctx.sourceProposalId
            ? { sourceProposalId: ctx.sourceProposalId }
            : {}),
        });
        // The row the door just wrote: the active binding of this object's
        // slot at this scope (the door supersedes, so there is one).
        const [row] = await database
          .select({ id: rendererBindings.id })
          .from(rendererBindings)
          .where(
            andWhere(
              eqWhere(rendererBindings.scopeKind, bindOp.scope),
              eqWhere(rendererBindings.subjectKind, bindOp.targetKind),
              eqWhere(rendererBindings.subjectId, bindOp.targetId),
              eqWhere(
                rendererBindings.contentKind,
                SLOT_TO_CONTENT_KIND[bindOp.slot]
              ),
              isNullWhere(rendererBindings.revokedAt)
            )
          )
          .orderBy(desc(rendererBindings.createdAt))
          .limit(1);
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "bind_renderer: the binding door wrote no active row",
          });
        }
        return { bindingId: row.id };
      },
    },

    // A Library rebuild's CHANGES (`update_*`), each through its object's
    // existing update door — see `composite-update-caller.ts`.
    updateCaller: buildCompositeUpdateCaller(ctx),
    skillCaller: {
      create: async (skillOp) => {
        const { insertSkillGoverned } = await import("../routers/skills.js");
        // Typed at the call site (NOT `as never` / `as any`): a blanket cast
        // here would silently defeat any future tightening of the skill insert
        // contract — a defect this repo has shipped.
        const created = await insertSkillGoverned({
          userId,
          workspaceId: skillOp.scope === "workspace" ? workspaceId : null,
          kind: "instruction",
          scope: skillOp.scope,
          // The ref `synap_load_skill` resolves — without it a teaching skill
          // is created unreachable.
          slug: skillOp.slug?.trim() || null,
          name: skillOp.name,
          body: skillOp.body,
          agentTypes: skillOp.agentTypes ?? null,
          // The operator is the authority — no agentUserId, so the re-entrant
          // gate auto-grants instead of re-proposing.
          agentUserId: undefined,
          // …but the skill is still its author's: born approved only by the
          // one rule, judged on the real author and on a person's approval.
          skillAuthor,
          auditSource,
        });
        if (created.status !== "installed") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_skill did not apply (${created.status})`,
          });
        }
        return { id: created.skill.id };
      },
    },

    automationCaller: {
      create: async (automationOp) => {
        const { materializeAutomationForPrincipal } =
          await import("../routers/automations.js");
        // The op carries its trigger config INSIDE the flow
        // (`flowDefinition.triggerConfig`). The preflight
        // (`validatePlanOperations`) refuses an EVENT automation without
        // `triggerConfig.eventPattern`, so `{}` here is only ever a cron /
        // webhook / manual trigger that needs none.
        const flow = automationOp.flowDefinition as {
          triggerConfig?: Record<string, unknown>;
        } | null;
        const created = await materializeAutomationForPrincipal({
          database,
          definition: {
            workspaceId: automationOp.workspaceId ?? workspaceId,
            name: automationOp.name,
            ...(automationOp.description
              ? { description: automationOp.description }
              : {}),
            triggerType: automationOp.triggerType,
            triggerConfig: flow?.triggerConfig ?? {},
            flowDefinition: automationOp.flowDefinition as {
              nodes: Array<Record<string, unknown>>;
              edges: Array<Record<string, unknown>>;
            },
            // A batch no person reviewed (a direct capture, an import) writes
            // drafts: its ops may be structured from pasted content.
            status: !skillAuthor.personApproved
              ? "draft"
              : automationOp.enabled === undefined
                ? undefined
                : automationOp.enabled
                  ? "active"
                  : "draft",
          },
          createdBy: ownerUserId,
          agentUserId: skillAuthor.agentUserId,
          personApproved: skillAuthor.personApproved,
          stableId: randomUUID(),
        });
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "create_automation did not materialize",
          });
        }
        return { id: created };
      },
    },

    ruleCaller: {
      create: async (ruleOp) => {
        const { createRuleGoverned } =
          await import("../services/rules/create.js");
        const created = await createRuleGoverned({
          userId,
          agentUserId: undefined,
          workspaceId,
          intent: ruleOp.intent,
          scope: ruleOp.scope,
          ...(ruleOp.factSkillId ? { factSkillId: ruleOp.factSkillId } : {}),
          automationIds: ruleOp.automationIds,
          auditSource,
        });
        if (created.status !== "created") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_rule did not apply (${created.status})`,
          });
        }
        return { id: created.ruleId };
      },
    },

    // A process (`create_playbook`), through the EXISTING
    // `playbooks.create` door — the same caller shape the playbook approval
    // executor builds (`executors/playbook.ts`), membership-floored. No
    // agentUserId: the governance decision was already made for the graph, so
    // the re-entrant door grants instead of filing a second proposal.
    playbookCaller: {
      create: async (playbookOp) => {
        const playbookWorkspaceId = playbookOp.workspaceId ?? workspaceId;
        if (!playbookWorkspaceId) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "create_playbook needs a workspace: a process lives in a space.",
          });
        }
        const { getWorkspaceMembership } = await import("@synap/database");
        const membership = await getWorkspaceMembership(
          database as Parameters<typeof getWorkspaceMembership>[0],
          playbookWorkspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        // The one birth decision. A batch no person reviewed may be
        // structured from pasted content, so it is judged as an agent's.
        const status = statusAtCreate({
          requested: playbookOp.status,
          personApproved: skillAuthor.personApproved,
          actorIsAgent: true,
        });
        const { playbooksRouter } = await import("../routers/playbooks.js");
        const caller = playbooksRouter.createCaller({
          db: database,
          authenticated: true as const,
          userId,
          workspaceId: playbookWorkspaceId,
          workspaceRole: membership.role,
        } as unknown as Parameters<typeof playbooksRouter.createCaller>[0]);
        const created = await caller.create({
          name: playbookOp.name,
          ...(playbookOp.description
            ? { description: playbookOp.description }
            : {}),
          goalTemplate: playbookOp.goalTemplate,
          subjectProfile: playbookOp.subjectProfile,
          status,
        });
        if (created.status !== "created" || !created.playbook) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_playbook did not apply (${created.status})`,
          });
        }
        return { id: created.playbook.id, status };
      },
    },

    // A LIST (`create_view`), through the EXISTING `views.create` door — the
    // same caller shape the `view/create` approval executor builds
    // (`executors/view.ts`), membership-floored. No agentUserId: the graph's
    // governance decision is already made.
    //
    // Scoping: the members become the view's FIXED set (`query.entityIds`,
    // honoured by `views.execute`); the group container is recorded on the
    // config as `membersOf`, so a later "members of X" filter can make the
    // list live. Kinds: the op's slugs, else the members' own kinds.
    viewCaller: {
      create: async (viewOp) => {
        const {
          getWorkspaceMembership,
          ProfileResolutionService,
          entities,
          inArray,
        } = await import("@synap/database");
        const viewWorkspaceId = viewOp.workspaceId ?? workspaceId;
        let workspaceRole = "owner";
        if (viewWorkspaceId) {
          const membership = await getWorkspaceMembership(
            database as Parameters<typeof getWorkspaceMembership>[0],
            viewWorkspaceId,
            userId
          );
          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No workspace access",
            });
          }
          workspaceRole = membership.role;
        }

        const scopeProfileIds = new Set<string>();
        if (viewOp.scopeProfileSlugs?.length) {
          const resolver = new ProfileResolutionService(database);
          for (const slug of viewOp.scopeProfileSlugs) {
            const profile = await resolver.resolveProfile(
              slug,
              userId,
              viewWorkspaceId ?? null
            );
            if (!profile?.id) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `create_view: no kind "${slug}" in this space`,
              });
            }
            scopeProfileIds.add(profile.id);
          }
        } else if (viewOp.entityIds.length > 0) {
          const rows = await database
            .select({ profileId: entities.profileId })
            .from(entities)
            .where(inArray(entities.id, viewOp.entityIds));
          for (const row of rows) {
            if (row.profileId) scopeProfileIds.add(row.profileId);
          }
        }
        if (scopeProfileIds.size === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "create_view: the list names no kind and none of its things has one",
          });
        }

        const { viewsRouter } = await import("../routers/views.js");
        const caller = viewsRouter.createCaller({
          db: database,
          authenticated: true as const,
          userId,
          workspaceId: viewWorkspaceId ?? null,
          workspaceRole,
        } as unknown as Parameters<typeof viewsRouter.createCaller>[0]);
        const created = await caller.create({
          name: viewOp.name,
          type: viewOp.viewType,
          ...(viewWorkspaceId ? { workspaceId: viewWorkspaceId } : {}),
          scopeProfileIds: [...scopeProfileIds],
          ...(viewOp.entityIds.length > 0
            ? { query: { entityIds: viewOp.entityIds } }
            : {}),
          config: {
            ...(viewOp.config ?? {}),
            ...(viewOp.containerEntityId
              ? { membersOf: viewOp.containerEntityId }
              : {}),
          },
        });
        const view = (created as { view?: { id?: string } | null }).view;
        if (created.status !== "created" || !view?.id) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_view did not apply (${created.status})`,
          });
        }
        return { id: view.id };
      },
    },
  };
}
