/**
 * Skills Router
 *
 * Synchronous CRUD operations for user-created skills.
 * Direct DB operations with inline permission checks.
 * Skills are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, desc, inArray, type SQL } from "@synap/database";
import { skills, tools } from "@synap/database/schema";
import type { ProviderVerbSpec } from "@synap/database/schema";
import {
  getLinksFor,
  createLinks,
  deleteLink,
} from "../services/links/links-service.js";
import { requireUserId } from "../utils/user-scoped.js";
import { visibleSkillsWhere } from "../services/skills/visibility.js";
import { ruleNotExpiredWhere } from "../services/rules/expiry.js";
import { ruleSentenceSchema } from "../services/rules/sentence-schema.js";
import { safeExternalFetch } from "@synap/shared-utils";
import {
  checkPermissionOrPropose,
  createPendingProposal,
} from "../utils/permission-check.js";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import {
  allowedHostsChanged,
  skillExecFieldsChanged,
} from "../services/capabilities/skill-exec-fields.js";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "../services/proposals/proposal-class.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID } from "crypto";
import { parseSkillMd } from "../skills/skill-md-parser.js";
import { parseSkillToml } from "../skills/skill-toml-parser.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";
import {
  SKILL_RUNTIME_VERSION as STDLIB_RUNTIME_VERSION,
  SKILL_WEB_GLOBALS,
  SKILL_HOST_BRIDGES,
  SKILL_ALLOWED_GLOBALS,
} from "../services/skills/skill-stdlib.js";

/**
 * Save-time global-reference scan for code skills (B1).
 *
 * A code skill runs inside an isolated-vm isolate whose ONLY globals are
 * pure-ECMAScript built-ins + the versioned skill stdlib (host bridges + web
 * polyfills). A skill that references any OTHER global (e.g. `fetch`, `crypto`)
 * throws a ReferenceError at run time — the exact class of failure the
 * `URLSearchParams` polyfill patched reactively. This scan makes the AUTHOR/AI
 * learn the gap at CREATE time instead.
 *
 * SSOT: the allow-list is IMPORTED from the co-located backend runtime module
 * (`services/skills/skill-stdlib.ts`) — the SAME module the in-process sandbox
 * (`run-skill-in-sandbox.ts`) boots with — so the scan and the isolate can never
 * disagree within the backend. That backend module is itself a verbatim port of
 * the IS SSOT; `skill-runtime-globals.test.ts` still asserts byte-equality
 * against the IS sibling (until the IS copy is retired) so cross-repo drift is
 * caught.
 */
export const SKILL_RUNTIME_VERSION = STDLIB_RUNTIME_VERSION;

/** The derived allow-list — every identifier a skill may reference. */
export const SKILL_RUNTIME_ALLOWED_GLOBALS: ReadonlySet<string> = new Set(
  SKILL_ALLOWED_GLOBALS
);

/** Collect every binding name a pattern node introduces (destructuring-aware). */
function collectPatternNames(
  node: acorn.Node | null | undefined,
  out: Set<string>
): void {
  if (!node) return;
  const n = node as unknown as Record<string, unknown> & { type: string };
  switch (n.type) {
    case "Identifier":
      out.add(n.name as string);
      break;
    case "ObjectPattern":
      for (const p of n.properties as acorn.Node[]) collectPatternNames(p, out);
      break;
    case "Property":
      collectPatternNames(n.value as acorn.Node, out);
      break;
    case "ArrayPattern":
      for (const e of n.elements as (acorn.Node | null)[])
        e && collectPatternNames(e, out);
      break;
    case "RestElement":
      collectPatternNames(n.argument as acorn.Node, out);
      break;
    case "AssignmentPattern":
      collectPatternNames(n.left as acorn.Node, out);
      break;
  }
}

/**
 * Parse a skill body and return the free global identifiers it references that
 * are NOT in the runtime allow-list. Uses the SAME async-function wrapper the IS
 * executor uses, so `args`/`context`/top-level `await` parse identically.
 *
 * Detection = (identifiers referenced anywhere) − (identifiers bound anywhere) −
 * allow-list. "Bound anywhere" makes a local shadow of an allowed name safe and
 * never false-positives on locals; only a name that is never declared and not
 * provided by the runtime is flagged. Throws SyntaxError text on a parse failure.
 */
export function scanSkillGlobals(code: string): {
  ok: boolean;
  unknownGlobals: string[];
  parseError?: string;
} {
  const wrapped = `(async function(args, context){\n${code}\n})`;
  let ast: acorn.Node;
  try {
    ast = acorn.parse(wrapped, { ecmaVersion: 2022, sourceType: "script" });
  } catch (err) {
    return {
      ok: false,
      unknownGlobals: [],
      parseError: err instanceof Error ? err.message : "Syntax error",
    };
  }

  const bound = new Set<string>();
  const referenced = new Set<string>();

  acornWalk.fullAncestor(
    ast,
    (node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) => {
      const n = node as unknown as Record<string, unknown> & { type: string };
      switch (n.type) {
        case "VariableDeclarator":
          collectPatternNames(n.id as acorn.Node, bound);
          return;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (n.id) bound.add((n.id as { name: string }).name);
          for (const p of n.params as acorn.Node[])
            collectPatternNames(p, bound);
          return;
        case "ClassDeclaration":
        case "ClassExpression":
          if (n.id) bound.add((n.id as { name: string }).name);
          return;
        case "CatchClause":
          if (n.param) collectPatternNames(n.param as acorn.Node, bound);
          return;
      }
      if (n.type !== "Identifier") return;
      const name = n.name as string;
      const parent = ancestors[ancestors.length - 2] as unknown as
        (Record<string, unknown> & { type: string }) | undefined;
      if (!parent) {
        referenced.add(name);
        return;
      }
      // Exclude identifiers that are NOT variable references:
      if (
        parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed
      )
        return;
      if (
        parent.type === "Property" &&
        parent.key === node &&
        !parent.computed &&
        parent.value !== node
      )
        return;
      if (
        (parent.type === "MethodDefinition" ||
          parent.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed
      )
        return;
      if (parent.type === "LabeledStatement" && parent.label === node) return;
      if (
        (parent.type === "BreakStatement" ||
          parent.type === "ContinueStatement") &&
        parent.label === node
      )
        return;
      if (parent.type === "VariableDeclarator" && parent.id === node) return;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression") &&
        (parent.id === node || (parent.params as acorn.Node[]).includes(node))
      )
        return;
      referenced.add(name);
    }
  );

  const unknownGlobals = [...referenced]
    .filter(
      (name) => !bound.has(name) && !SKILL_RUNTIME_ALLOWED_GLOBALS.has(name)
    )
    .sort();
  return { ok: unknownGlobals.length === 0, unknownGlobals };
}

/**
 * Throw a TRPCError with an actionable message if `code` references a global the
 * skill runtime does not provide. No-op for empty/whitespace code.
 */
export function assertSkillGlobalsAllowed(
  code: string | undefined | null
): void {
  const trimmed = code?.trim();
  if (!trimmed) return;
  const scan = scanSkillGlobals(trimmed);
  if (scan.parseError) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Skill code has a syntax error: ${scan.parseError}`,
    });
  }
  if (!scan.ok) {
    const allowed = [...SKILL_WEB_GLOBALS, ...SKILL_HOST_BRIDGES].join(", ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Skill references ${scan.unknownGlobals.map((g) => `\`${g}\``).join(", ")}, ` +
        `not provided by skill runtime v${SKILL_RUNTIME_VERSION}. ` +
        `Code skills run in a sandbox with ECMAScript built-ins plus: ${allowed}. ` +
        `Use \`host.fetch(url, opts)\` for HTTP (not \`fetch\`); there is no \`crypto\`, ` +
        `\`process\`, \`require\`, or timers.`,
    });
  }
}

/**
 * Execution-defining content rule — the SHARED definition, so this door and the
 * template applier (`create-from-definition.ts`) can never drift apart. Lives in
 * a leaf module because the applier cannot statically import this router.
 */
export {
  RE_APPROVAL_FIELDS,
  allowedHostsChanged,
  skillExecFieldsChanged,
} from "../services/capabilities/skill-exec-fields.js";

/**
 * The ONE governed persistence path for inserting a `skills` row. Shared by
 * every skill-creation door (`create`, `installFromUrl` here, and the Hub
 * Protocol `/agent-skills/import` door) so none of them can bypass the same
 * `checkPermissionOrPropose` gate `create` runs — no door hardcodes
 * `approved: true` on its own insert.
 *
 * Born-approved rule: an `instruction` skill (prompt-only, no side effects) is
 * approved when installed by a trusted human (no `agentUserId`). Anything
 * executable (`code`/`declarative`), OR an install initiated by an agent
 * identity — including instruction content, which lands in the agent's system
 * prompt and is therefore a prompt-injection vector — is born UNAPPROVED and
 * needs an explicit owner approval (`setApproved`) before it runs or loads as
 * an agent tool.
 */
export type InsertSkillGovernedInput = typeof skills.$inferInsert & {
  agentUserId?: string;
  /** Folded into the audit-log `data` for observability, e.g. "install_from_url". */
  auditSource: string;
};

export type InsertSkillGovernedResult =
  | { status: "installed"; skill: typeof skills.$inferSelect }
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string };

export async function insertSkillGoverned(
  input: InsertSkillGovernedInput
): Promise<InsertSkillGovernedResult> {
  const {
    agentUserId,
    auditSource,
    id: _ignoredId,
    approved: _ignoredApproved,
    status: _ignoredStatus,
    ...values
  } = input;
  const skillId = randomUUID();

  // Save-time global-reference scan (B1) — the shared BACKSTOP for every door
  // that funnels through this governed insert (`installFromUrl`, the Hub
  // `/agent-skills/import` door, and any future caller). `create`/`update`
  // already scan earlier (before their own perm check + direct insert, which
  // do NOT call this function) — this is not a double-scan of the same code
  // path, it closes the gap for callers that construct a `kind: "code"` skill
  // without going through those two mutations.
  if (values.kind === "code") {
    assertSkillGlobalsAllowed(values.code);
  }

  const perm = await checkPermissionOrPropose({
    userId: values.userId,
    agentUserId,
    workspaceId: values.workspaceId ?? undefined,
    subjectType: "skill",
    action: "create",
    // Widened (object-proposal manifest W1): carry the FULL insert values so an
    // approved proposal materializes a real skill (kind/code/body/scope/
    // providerSpec/…) via the SAME insertSkillGoverned door — not just a label.
    // `values` is exactly the skill insert shape; only the PROPOSED (pending)
    // row's stored data widens — the granted-path insert below reads `values`
    // and `skillId` unchanged, so the direct-create path is byte-identical.
    data: { id: skillId, ...values },
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }

  const approved = values.kind === "instruction" && !agentUserId;

  const [skill] = await db
    .insert(skills)
    .values({
      ...values,
      id: skillId,
      status: "active",
      approved,
    })
    .returning();

  auditLog({
    subjectType: "skill",
    action: "create",
    phase: "completed",
    subjectId: skill.id,
    userId: values.userId,
    workspaceId: values.workspaceId ?? undefined,
    data: { name: values.name, kind: values.kind, source: auditSource },
  });

  emitSideEffects({
    subjectType: "skill",
    action: "create",
    subjectId: skill.id,
    userId: values.userId,
    workspaceId: values.workspaceId ?? undefined,
  });

  return { status: "installed", skill };
}

export const skillsRouter = router({
  /**
   * List skills for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          kind: z
            .enum(["instruction", "code", "declarative", "builtin"])
            .optional(),
          scope: z.enum(["pod", "user", "workspace"]).optional(),
          status: z.enum(["active", "inactive", "error", "all"]).optional(),
          /** When true, return only approved skills (the agent-tool loader uses this). */
          approved: z.boolean().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const conditions: SQL[] = [];

      conditions.push(visibleSkillsWhere(userId, input?.workspaceId));
      // An EXPIRED rule must stop acting. This is the read the IS
      // `dynamic-skill-loader` reaches through `/agent-skills/executable`, so
      // filtering here is what stops a lapsed standing intent from being
      // injected into the model's prompt. Vacuously true for every non-rule row
      // (no `metadata.rule` ⇒ NULL), so it narrows nothing else.
      // NOTE: deliberately NOT applied to `GET /api/hub/rules` — the owner must
      // still SEE an expired rule to renew or delete it. Expiry stops a rule
      // from ACTING, it does not hide it.
      conditions.push(ruleNotExpiredWhere());

      if (input?.kind) {
        conditions.push(eq(skills.kind, input.kind));
      }

      if (input?.scope) {
        conditions.push(eq(skills.scope, input.scope));
      }

      if (input?.status && input.status !== "all") {
        conditions.push(eq(skills.status, input.status));
      }

      if (input?.approved !== undefined) {
        conditions.push(eq(skills.approved, input.approved));
      }

      const results = await ctx.db.query.skills.findMany({
        where: and(...conditions),
        orderBy: [desc(skills.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      return { skills: results };
    }),

  /**
   * Get a single skill by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Required to resolve a workspace-scoped skill; omitted = pod + own only. */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          visibleSkillsWhere(userId, input.workspaceId)
        ),
      });

      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      return { skill };
    }),

  // ── Rule Loop (NS1) ────────────────────────────────────────────────────
  // A RULE is a `skills` row (`category: "rule"`) whose `metadata.rule` blob
  // carries intent / scope / trust / lineage / divergence snapshot — see
  // `services/rules/index.ts` for why this is a composition and not a table.
  // These three doors live on the skills router for the same reason.

  /**
   * Governed rule create. Returns `{ status: "proposed" }` for a caller the
   * gate routes to review — that is the normal agent path, not an error; the
   * `rule/create` approve executor applies it.
   */
  createRule: protectedProcedure
    .input(
      z.object({
        intent: z.string().min(1),
        scope: z.object({
          kind: z.enum(["pod", "workspace", "user"]),
          workspaceId: z.string().uuid().optional(),
          /** Cross-cutting project lens — composes with the workspace lens. */
          projectId: z.string().uuid().optional(),
        }),
        /** ISO-8601 instant after which the rule stops applying. */
        expiresAt: z.string().datetime({ offset: true }).optional(),
        factSkillId: z.string().uuid().optional(),
        automationIds: z.array(z.string().uuid()).default([]),
        /**
         * The rule's structured WHEN/WHERE/THEN. Present ⇒ the door COMPILES it
         * into an automation or refuses the create naming the failing clause;
         * absent ⇒ a prose-only `fact` rule. Validated by
         * `ruleSentenceSchema` inside the door, which is bound to the shared
         * `RuleSentenceValue` at compile time — re-declaring the shape here
         * would be a second copy of the grammar.
         */
        sentence: ruleSentenceSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { createRuleGoverned } =
        await import("../services/rules/create.js");
      const result = await createRuleGoverned({
        userId,
        ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
        workspaceId: input.scope.workspaceId ?? ctx.workspaceId ?? null,
        intent: input.intent,
        scope: input.scope,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
        automationIds: input.automationIds,
        ...(input.sentence ? { sentence: input.sentence } : {}),
        auditSource: "rules.createRule",
      });
      // CONTRACT, deliberate and different from the Hub REST door (which maps
      // `denied` to 403 because HTTP has no other way to say it): this
      // procedure RETURNS the three-way verdict as a discriminated union and
      // does not throw on a refusal.
      //
      // A refusal here is a REVIEWED, actionable outcome — it names the failing
      // clause (WHEN / WHERE / THEN) and the reason, and the caller is expected
      // to show that to the author. `browser`'s `ruleDoor.ts` already renders
      // all three arms; throwing would collapse its refusal copy into a generic
      // error and lose the clause. The union's discriminant makes the arm hard
      // to ignore, which a thrown error would not.
      //
      // Pinned by `skills.createRule.contract.test.ts` — if this ever starts
      // throwing, that surface silently loses its refusal message.
      return result;
    }),

  /**
   * DRY RUN a rule's behaviour against REAL history — "how many stored events
   * match this trigger?", answered BEFORE the rule exists.
   *
   * Named `dryRunRule` and mounted HERE, on the skills router, for the same
   * reason `createRule` / `listRules` are: a rule IS a `skills` row, and a
   * second router door for the same object is a fork. It is NOT
   * `governanceRules.dryRun`, which belongs to the authorization store and
   * answers a different question entirely (see `services/rules/dry-run.ts`).
   *
   * Returns a MATCH COUNT, never a firing count. `matchingEventCount` is the
   * number of persisted events the compiled trigger matches; it is not what
   * "would have fired", because the live path also applies cycle detection,
   * the chain ceiling, the exactly-once claim, the automation's status and the
   * governance floor on its THEN. For a rule that already exists,
   * `actualRunCount` reports REAL firings from `automation_runs` — a different
   * number answering a different question, deliberately kept separate.
   *
   * Compiles through the ONE compiler (`compileRuleSentence`, the same call
   * `createRuleGoverned` makes before the gate), so a sentence that dry-runs
   * is a sentence that will create, and a refusal names the same clause.
   */
  dryRunRule: protectedProcedure
    .input(
      z.object({
        /** The draft sentence — the SAME schema `createRule` accepts. */
        sentence: ruleSentenceSchema,
        /** How far back to replay. */
        windowDays: z.number().int().min(1).max(90).default(7),
        /** Narrows the caller's own events; can never widen the floor. */
        workspaceId: z.string().uuid().optional(),
        /**
         * An EXISTING rule to additionally report real firings for. Read under
         * `visibleSkillsWhere` — a rule the caller cannot see contributes no
         * automation ids, so the run count is simply absent.
         */
        ruleId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { compileRuleSentence } =
        await import("../services/rules/compile.js");
      const compiled = compileRuleSentence(input.sentence);
      if (!compiled.ok) {
        // Same contract as `createRule`: a refusal is a RETURNED verdict that
        // names the failing clause, not a thrown error that loses it.
        return {
          status: "denied" as const,
          reason: compiled.failure.reason,
          failure: compiled.failure,
        };
      }

      let automationIds: string[] = [];
      if (input.ruleId) {
        // The rule row is resolved under `visibleSkillsWhere` FIRST; only then
        // is its lineage read. `readRuleAutomationIds` is caller-gated, so a
        // rule the caller cannot see contributes no automation ids and the run
        // count is simply absent — unchanged from the JSONB read it replaces.
        const { readRuleAutomationIds } =
          await import("../services/rules/lineage.js");
        const row = await db.query.skills.findFirst({
          where: and(
            eq(skills.id, input.ruleId),
            eq(skills.category, "rule"),
            // OWNER-FACING: a replay the caller explicitly asked for. It reads
            // history and fires nothing, so expiry has nothing to enforce here
            // — and "what did this match before it lapsed?" is a fair question
            // to ask about a rule precisely because it lapsed.
            visibleSkillsWhere(userId, input.workspaceId, {
              includeExpired: true,
            })
          ),
          columns: { id: true },
        });
        // MEMBERSHIP comes from the `skill --activates--> automation` EDGE, not
        // from `metadata.rule.behaviours[].automationId`. The JSONB copy holds
        // only the divergence snapshot now.
        automationIds = row ? await readRuleAutomationIds(row.id) : [];
      }

      const { runRuleDryRun } = await import("../services/rules/dry-run.js");
      const { AccessContext } = await import("../access/context.js");
      const { scopedDb } = await import("../access/index.js");
      const { automationRuns } = await import("@synap/database");

      return runRuleDryRun({
        userId,
        triggerType: compiled.trigger.triggerType,
        triggerConfig: compiled.trigger.triggerConfig,
        windowDays: input.windowDays,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        automationIds,
        runVisibility: scopedDb(AccessContext.from(ctx)).predicate(
          automationRuns
        ),
      });
    }),

  /**
   * List rules under the caller's visibility floor — the SAME
   * `visibleSkillsWhere` predicate every other skills read uses (a rule is a
   * skill row, so it can never be more visible than a skill).
   *
   * `includeProposed` (default FALSE) additionally returns rules that exist
   * only as a PENDING proposal — no `skills` row yet. Default-off is
   * deliberate: a caller that reads this list to decide what is IN EFFECT must
   * keep getting only materialized rules. It is opt-in for the surfaces whose
   * job is to show what EXISTS (the CLI listing, an agent checking "did anyone
   * already ask for this?") — the read that stops a duplicate proposal.
   * Proposed rows are never merged silently: each carries
   * `status: "proposed"` + `proposalId`, and approved rows carry
   * `status: "active"`.
   */
  listRules: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
          /** Also return rules that exist only as a pending proposal. */
          includeProposed: z.boolean().default(false),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { readRuleMetadata, RULE_CATEGORY } =
        await import("../services/rules/index.js");
      const rows = await ctx.db.query.skills.findMany({
        where: and(
          eq(skills.category, RULE_CATEGORY),
          // OWNER-FACING: the rule inventory its owner manages. An expired rule
          // must stop ACTING, not disappear — it has to be visible to be
          // renewed or deleted, and the design organises this very list by
          // health (All / Active / Broken / Expiring), which cannot show an
          // "Expiring" group built from rows the query removed.
          visibleSkillsWhere(userId, input?.workspaceId, {
            includeExpired: true,
          })
        ),
        orderBy: [desc(skills.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });
      // Membership comes from the EDGE, projected onto the list in ONE query.
      //
      // Without this the payload carried only the raw `rule` blob, and the CLI
      // counted behaviours off `rule.behaviours.length` while the browser asked
      // the backend, which reads the edge. Two doors, two stores, one question —
      // and they disagree exactly where the new `"unsnapshotted"` status was
      // introduced to name the anomaly: a rule with an edge but no snapshot read
      // 0 attached on the CLI and 1 in the browser, and the reverse for a
      // snapshot with no edge. The fix belongs here, not in a wider client read.
      const { readRuleHealthBulk } =
        await import("../services/rules/lineage.js");
      const health = await readRuleHealthBulk(
        rows.map((row: typeof skills.$inferSelect) => row.id)
      );
      const materialized = rows.flatMap((row: typeof skills.$inferSelect) => {
        const rule = readRuleMetadata(row.metadata);
        return rule
          ? [
              {
                id: row.id,
                name: row.name,
                approved: row.approved,
                workspaceId: row.workspaceId,
                createdAt: row.createdAt,
                rule,
                /**
                 * The rule's automations, from the `activates` edge — the
                 * membership store. Prefer this over `rule.behaviours`, which
                 * now holds only the divergence snapshot.
                 */
                automationIds: health.get(row.id)?.automationIds ?? [],
                /**
                 * Health, so a list can GROUP by it without N+1-ing per row.
                 * `behaviourStatus: "error"` is the honest "Broken" — this
                 * rule's behaviour is failing to run. It is NOT connection
                 * health; no producer for that exists, so a surface must not
                 * name a cause ("connection expired") nobody measured.
                 */
                behaviourStatus: health.get(row.id)?.worstStatus ?? null,
                lastRunAt: health.get(row.id)?.lastRunAt ?? null,
                /** Lifetime RUNS — never a match count. */
                runCount: health.get(row.id)?.runCount ?? 0,
                status: "active" as const,
                proposalId: undefined as string | undefined,
              },
            ]
          : [];
      });
      if (!input?.includeProposed) return { rules: materialized };

      const { listPendingRuleProposals } =
        await import("../services/proposals/pending-rules.js");
      const proposed = await listPendingRuleProposals({
        userId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        limit: input.limit || 50,
      });
      // Proposed FIRST: they are the ones awaiting a decision.
      return { rules: [...proposed, ...materialized] };
    }),

  /**
   * Get one rule, WITH divergence detection: for each behaviour the rule
   * produced, compare the flow hash the rule recorded at creation against the
   * automation's flow hash today. Detection only — nothing reconciles.
   */
  /**
   * Move (or clear) a rule's review date. The ONLY safe way to renew one.
   *
   * ── WHY A DEDICATED DOOR AND NOT `skills.update` ────────────────────────
   * `skills.update` accepts a `metadata` patch that is SHALLOW-merged onto the
   * row bag. `expiresAt` lives one level deeper, inside `metadata.rule`, so a
   * caller renewing through that door has to send the WHOLE `rule` object back
   * — and any field they omit is destroyed. Omitting `intent` erases the rule's
   * prose (it IS the fact an agent reads); omitting `behaviours` erases the
   * divergence snapshot. A renew path that silently corrupts the rule it renews
   * is worse than no path, because it looks like it works.
   *
   * This procedure reads the stored metadata, replaces exactly one field, and
   * writes the whole object back — so nothing can be dropped by omission.
   *
   * It is also the other half of expiry being enforced at all. The matcher and
   * the cron scheduler now stop an expired rule from firing, and the owner-
   * facing doors deliberately keep showing it (`includeExpired`) — both of
   * which are pointless if the owner has no way to act on what they can see.
   *
   * `expiresAt: null` CLEARS the date (the rule becomes permanent). That is a
   * different act from setting a date far in the future and is spelled
   * differently, so neither can be mistaken for the other.
   */
  renewRule: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
        /** ISO-8601. `null` clears the expiry; absent is rejected, not guessed. */
        expiresAt: z.string().datetime({ offset: true }).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { readRuleMetadata, RULE_CATEGORY, RULE_METADATA_KEY } =
        await import("../services/rules/index.js");
      const { withRuleExpiry } = await import("../services/rules/expiry.js");

      const row = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          eq(skills.category, RULE_CATEGORY),
          // OWNER-FACING, and load-bearing here above all: an EXPIRED rule is
          // the main thing anyone renews. Enforcing expiry on this read would
          // make the procedure unable to act on its own primary case.
          visibleSkillsWhere(userId, input.workspaceId, {
            includeExpired: true,
          })
        ),
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
      }

      const metadata = readRuleMetadata(
        row.metadata as Record<string, unknown> | null
      );
      if (!metadata) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This skill is categorised as a rule but carries no rule metadata, so there is no review date to move.",
        });
      }

      // One field changes; every other one is carried through. The "nothing
      // else changed" guarantee is asserted in `expiry.test.ts` against the
      // pure function, not through a mocked database here.
      const next = withRuleExpiry(metadata, input.expiresAt);

      await ctx.db
        .update(skills)
        .set({
          metadata: {
            ...((row.metadata as Record<string, unknown> | null) ?? {}),
            [RULE_METADATA_KEY]: next,
          },
          updatedAt: new Date(),
        })
        .where(eq(skills.id, input.id));

      return { id: input.id, expiresAt: next.expiresAt ?? null };
    }),

  getRule: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { readRuleMetadata, detectRuleDivergence, RULE_CATEGORY } =
        await import("../services/rules/index.js");
      const row = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          eq(skills.category, RULE_CATEGORY),
          // OWNER-FACING: a rule's own detail page. Without the waiver an
          // expired rule 404s here, so the only surface that could offer
          // "renew" is unreachable exactly when it is needed.
          visibleSkillsWhere(userId, input.workspaceId, {
            includeExpired: true,
          })
        ),
      });
      const rule = row ? readRuleMetadata(row.metadata) : null;
      if (!row || !rule) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
      }
      // MEMBERSHIP from the `skill --activates--> automation` EDGE — the store.
      // `rule.behaviours[]` is consulted only for the flowHash snapshot, keyed
      // by the ids the edge yields.
      const { readRuleAutomationIds, readRuleFactSkillId } =
        await import("../services/rules/lineage.js");
      const divergence = await detectRuleDivergence(
        await readRuleAutomationIds(row.id),
        rule
      );
      // The OTHER edge `linkRuleHalves` writes — `skill(fact) --documents-->
      // skill(rule)`. Read from the edge for the same reason as the behaviour
      // half: the JSONB `factSkillId` is a copy, the edge is the store.
      const factSkillId = await readRuleFactSkillId(row.id);
      return {
        rule: {
          id: row.id,
          name: row.name,
          approved: row.approved,
          workspaceId: row.workspaceId,
          createdAt: row.createdAt,
          rule: { ...rule, ...(factSkillId ? { factSkillId } : {}) },
        },
        divergence,
      };
    }),

  /**
   * Create a new skill
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        // A skill is Documentation (always) + optional Code. `kind` is derived
        // from whether code is present; still accepted for back-compat.
        // `declarative` = a Tier-1 in-process verb (carries `providerSpec`).
        kind: z
          .enum(["instruction", "code", "declarative", "builtin"])
          .optional(),
        scope: z.enum(["pod", "user", "workspace"]).default("pod"),
        agentTypes: z.array(z.string()).optional(),
        /** Stable ref `load_skill` resolves by (e.g. "biz/business-plan").
         *  Without one, a documentation skill is authored but unreachable:
         *  `resolveSkillContent` matches on `slug` ONLY. `system/` is reserved
         *  for seeded skills — a user row there would shadow them (that
         *  resolver ORs `system/<stem>` against a user-visible row, LIMIT 1). */
        slug: z
          .string()
          .min(1)
          .max(255)
          .regex(
            /^[a-z0-9]+(?:[-_.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_.][a-z0-9]+)*)*$/,
            "slug must be lowercase path segments, e.g. 'biz/business-plan'"
          )
          .refine((s) => !s.startsWith("system/"), {
            message:
              "the 'system/' slug namespace is reserved for seeded skills",
          })
          .optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        /** Documentation (Markdown): what the skill does + when to use it. */
        body: z.string().optional(),
        /** Optional executable — present ⇒ the skill is runnable (sandboxed). */
        code: z.string().optional(),
        /** Declarative provider-verb spec (kind="declarative"). */
        providerSpec: z.record(z.string(), z.unknown()).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).default("sync"),
        timeoutSeconds: z.number().min(1).max(300).default(30),
        /** The acting AGENT identity, when this create is agent-initiated
         *  (e.g. via an MCP tool) — mirrors entities.ts's createEntity input.
         *  Threaded into checkPermissionOrPropose below so an agent-created
         *  skill is gated by the agent's grant/role, not silently evaluated
         *  as if the human owner created it directly. */
        agentUserId: z.string().uuid().optional(),
        /** Free-form metadata bag persisted on the skill row — e.g. the
         *  marketplace source-link (`marketSource`) a standalone-install stamps
         *  so a published fix can reconcile the installed skill. */
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skillId = randomUUID();

      // Documentation + optional Code. Derive `kind` from code presence (explicit
      // input.kind still honored). A skill must carry documentation or code.
      const hasCode = !!input.code?.trim();
      const kind = input.kind ?? (hasCode ? "code" : "instruction");
      // `declarative` (providerSpec) and `builtin` (in-process handler) carry no
      // body/code, so they are exempt from the documentation-or-code requirement.
      if (
        kind !== "declarative" &&
        kind !== "builtin" &&
        !input.body?.trim() &&
        !hasCode
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A skill needs documentation or code.",
        });
      }
      // A declarative verb IS its providerSpec — require it so the skill cannot be
      // created malformed (a declarative skill with no spec misroutes at run time).
      if (kind === "declarative" && !input.providerSpec) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A declarative skill requires a providerSpec.",
        });
      }

      // Save-time global-reference scan (B1): reject a code skill that references
      // a global the isolate runtime doesn't provide (e.g. `fetch`/`crypto`)
      // BEFORE it persists — the single funnel every code-skill create hits
      // (human UI, AI via /agent-skills/executable → this create). The author/AI
      // learns the gap now, not the reviewer at approval or the run at execution.
      if (hasCode) {
        assertSkillGlobalsAllowed(input.code);
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: input.workspaceId,
        subjectType: "skill",
        action: "create",
        // Widened (object-proposal manifest W1): carry the FULL resolved insert
        // shape (matching insertSkillGoverned's `values`) so an approved proposal
        // materializes a real skill via the shared insertSkillGoverned door. Only
        // the PROPOSED (pending) row's stored data widens — the granted-path
        // insert below is byte-untouched. `kind` is the DERIVED kind (not raw
        // input.kind) so the materialized skill's kind matches the direct path.
        data: {
          id: skillId,
          userId,
          workspaceId: input.workspaceId ?? null,
          kind,
          scope: input.scope,
          agentTypes: input.agentTypes ?? null,
          slug: input.slug ?? null,
          name: input.name,
          description: input.description,
          body: input.body ?? null,
          code: input.code ?? null,
          providerSpec: input.providerSpec ?? null,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
        },
        agentUserId: input.agentUserId,
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id: skillId,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // 2. Direct DB operation.
      //    Born-draft carve-out (D-D): `instruction` skills are prompt-only with
      //    no side effects → born approved. `code` skills execute → born draft
      //    (DEFAULT false) and require an owner to approve before they run or
      //    load as agent tools.
      //    …but ONLY for a trusted human author. An AGENT-initiated instruction
      //    skill is born UNAPPROVED: its body lands in a future agent's system
      //    prompt, so prose is a prompt-injection vector exactly as code is an
      //    execution one. This mirrors `insertSkillGoverned`'s rule verbatim
      //    (`kind === "instruction" && !agentUserId`); the two born-approved
      //    decisions MUST stay identical or this direct path becomes the
      //    bypass the shared door exists to prevent. Normally an agent create
      //    returns `proposed` before reaching here — this closes the case where
      //    a governance rule has widened `skill/create` to auto for an agent.
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
          userId,
          // Pod-wide by default: only stamp a workspace when the caller explicitly
          // narrows to one. No workspace context → pod-wide (NULL).
          workspaceId: input.workspaceId ?? null,
          kind,
          scope: input.scope,
          agentTypes: input.agentTypes ?? null,
          slug: input.slug ?? null,
          name: input.name,
          description: input.description,
          body: input.body ?? null,
          code: input.code ?? null,
          providerSpec:
            (input.providerSpec as ProviderVerbSpec | undefined) ?? null,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
          // Persist the caller-supplied metadata bag (e.g. the marketplace
          // source-link); omitted → the column default `{}` applies.
          ...(input.metadata ? { metadata: input.metadata } : {}),
          status: "active",
          approved: kind === "instruction" && !input.agentUserId,
        })
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "create",
        phase: "completed",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
        data: { name: input.name },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "create",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: skill.id,
        status: "created" as const,
      };
    }),

  /**
   * Update a skill
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /**
         * AI attribution — set by AI callers, mirroring `create`. Load-bearing
         * for re-approval: an agent rewriting an `instruction` skill's `body`
         * must re-earn approval, because that body is injected verbatim into an
         * agent's system prompt.
         */
        agentUserId: z.string().uuid().optional(),
        kind: z
          .enum(["instruction", "code", "declarative", "builtin"])
          .optional(),
        scope: z.enum(["pod", "user", "workspace"]).optional(),
        agentTypes: z.array(z.string()).nullable().optional(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        /** Documentation (Markdown): what the skill does + when to use it. */
        body: z.string().optional(),
        /** Optional executable; empty clears it (doc-only). */
        code: z.string().optional(),
        /**
         * Declarative provider-verb spec (kind="declarative") — mirrors `create`.
         * Updatable because a published template fix to a declarative skill's
         * provider spec must be able to REACH an already-installed row: the
         * standalone-config reconcile builds its desired set from the install
         * baseline's keys, and `providerSpec` is one of them. Absent here, zod
         * stripped it silently — the reconcile then advanced the baseline and
         * reported `updated: [providerSpec]` for a row it never changed, which
         * classifies the field as user-edited forever.
         */
        providerSpec: z.record(z.string(), z.unknown()).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).optional(),
        timeoutSeconds: z.number().min(1).max(300).optional(),
        /**
         * Free-form metadata patch — SHALLOW-MERGED onto the existing row bag
         * (mirrors `views`/`automations` update; never a wholesale replace). The
         * standalone-config reconcile uses this to advance `metadata.marketSource`
         * (source-link + baseline) after applying a template update; without it a
         * skill's baseline could never advance past the first reconcile.
         */
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // `agentUserId` is attribution, NOT a column — peel it off so the spread
      // below never carries it into the skills UPDATE. `metadata` is peeled too:
      // it is MERGED onto the existing bag below, not spread-replaced.
      const {
        id,
        agentUserId: _agentUserId,
        metadata: metadataPatch,
        ...updateData
      } = input;

      // Save-time global-reference scan (B1) — same gate as `create`: an EDIT
      // that re-points a skill's code to reference an unprovided global (fetch/
      // crypto/…) is the same ReferenceError-at-run bug the create scan closes.
      if (input.code?.trim()) {
        assertSkillGlobalsAllowed(input.code);
      }

      // Verify skill exists and user has access (owner or pod-scoped)
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "update",
        // Widened (gate-payload sufficiency): `{ id }` described NO change, so an
        // approved skill-update proposal had nothing to apply. Carry the raw
        // patch (`updateData` = input minus `id`/`agentUserId`/`metadata`, plus
        // the metadata patch under its own key) — i.e. exactly the procedure
        // INPUT, so an approve-executor replays this same mutation and re-derives
        // `kind`/`code`-emptying and the `execChanged` re-approval reset itself
        // rather than storing a half-applied result. Only the PROPOSED row's
        // stored data widens; the granted path below is byte-untouched.
        data: {
          id,
          ...updateData,
          ...(metadataPatch ? { metadata: metadataPatch } : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // Documentation + optional Code: when code is set, derive `kind` (unless
      // given) and store empty code as null (the skill becomes doc-only).
      if (updateData.code !== undefined) {
        const trimmed = updateData.code.trim();
        (updateData as Record<string, unknown>).code = trimmed
          ? updateData.code
          : null;
        if (updateData.kind === undefined) {
          (updateData as Record<string, unknown>).kind = trimmed
            ? "code"
            : "instruction";
        }
      }

      // Security: if any execution-defining field actually CHANGES, the skill
      // may now run different code — reset approval so an approved skill can't
      // be silently re-pointed to execute untrusted code. Computed HERE, after
      // the normalization above, so it compares exactly the values the UPDATE
      // writes (an emptied `code` normalizes to null, and a derived `kind` is
      // already resolved) rather than the raw input.
      const execChanged =
        skillExecFieldsChanged(
          updateData as Record<string, unknown>,
          existingSkill as unknown as Record<string, unknown>
        ) ||
        // An AGENT rewriting `body` must re-earn approval. `body` is not
        // executable, so it isn't in RE_APPROVAL_FIELDS — but for an
        // `instruction` skill the body IS injected verbatim into an agent's
        // system prompt (is-agent-executor.ts). Without this, an agent could
        // take an already-approved instruction skill and rewrite its body while
        // it KEPT `approved: true` — precisely the "hostile fetched content
        // persists itself into the prompt" path the approval gate exists to
        // stop. A human editing their own skill is unaffected. Deliberately
        // PRESENCE-based, not value-based: an agent that submits a body must
        // re-earn approval even in the edge case where the text is unchanged.
        (updateData.body !== undefined && !!input.agentUserId) ||
        // Widening the sandbox's egress allowlist is an execution change: it is
        // what decides which hosts an approved skill may reach. It cannot ride
        // in `RE_APPROVAL_FIELDS` because `metadata` is peeled off `updateData`
        // above and merged separately, so the fields check never sees it.
        allowedHostsChanged(
          metadataPatch as Record<string, unknown> | undefined,
          existingSkill.metadata as Record<string, unknown> | null
        );

      // The column is typed `ProviderVerbSpec`; the input accepts the open
      // `z.record` shape the spec is stored as. Narrow it for the write — same
      // cast `create` applies above — WITHOUT peeling it off `updateData`, which
      // the RE_APPROVAL_FIELDS check and the audit payload both read.
      const columnPatch = updateData as Omit<
        typeof updateData,
        "providerSpec"
      > & { providerSpec?: ProviderVerbSpec };

      // 2. Direct DB operation
      const [_updated] = await db
        .update(skills)
        .set({
          ...columnPatch,
          // Shallow-merge the metadata patch onto the existing bag (never replace)
          // — same semantics as views/automations update.
          ...(metadataPatch
            ? {
                metadata: {
                  ...((existingSkill.metadata as Record<string, unknown>) ??
                    {}),
                  ...metadataPatch,
                },
              }
            : {}),
          ...(execChanged ? { approved: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id))
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "update",
        phase: "completed",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: updateData,
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "update",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "updated" as const,
      };
    }),

  /**
   * Delete a skill
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify skill exists and user has access (owner or pod-scoped)
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      await db.delete(skills).where(eq(skills.id, input.id));

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "delete",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "deleted" as const,
      };
    }),

  /**
   * Execute a skill by ID
   *
   * Delegates execution to the Intelligence Hub which has the sandboxed
   * executor. Updates execution metadata (count + lastTestedAt) on success.
   */
  execute: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Free-form parameter map passed to the skill's code */
        input: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify skill exists and user has access (owner or pod-scoped)
      const skill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!skill) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }

      // Lifecycle gate (NOT governance): a draft/disabled skill never runs.
      if (skill.status !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Skill is not active (status: ${skill.status})`,
        });
      }

      // Capability-execution gate (Wave 3b chokepoint) — supersedes the bare
      // `approved` boolean. Owner-bypass: the skill's owner runs their own skill.
      // A non-owner with an UNAPPROVED skill routes to `propose` (don't run); an
      // approved skill + auto resolves to run. This is the operator/UI door
      // (protectedProcedure) — there is no agent identity here, so an approved
      // skill run by its accessible operator stays auto (no behavior change).
      const skillDecision = await gateCapabilityExecution({
        capabilityKind: "skill",
        capabilityId: skill.id,
        skill: { id: skill.id, approved: skill.approved, userId: skill.userId },
        actorUserId: userId,
        workspaceId: skill.workspaceId ?? null,
        issuer: "skills.execute",
      });

      if (skillDecision.decision === "deny") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: skillDecision.reason,
        });
      }
      if (skillDecision.decision === "propose") {
        // Don't run — materialize a reviewable capability/run proposal. A
        // pod-wide (null-workspace) skill has no review surface; require approval
        // upfront rather than silently running (safe-by-default).
        if (!skill.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Skill is not approved for execution.",
          });
        }
        const proposal = await createPendingProposal({
          userId,
          workspaceId: skill.workspaceId,
          targetType: "capability",
          targetId: skill.id,
          // ONE literal, imported — a private `"run"` here classified every
          // skill run as objectWork, which never expires.
          proposalType: CAPABILITY_RUN_PROPOSAL_TYPE,
          data: {
            capabilityKind: "skill",
            capabilityId: skill.id,
            input: input.input ?? {},
            workspaceId: skill.workspaceId,
          },
          notificationDescription: `Run skill ${skill.name}`,
        });
        return {
          success: false as const,
          proposed: true as const,
          proposalId: proposal.id,
          executionTimeMs: 0,
        };
      }
      if (skillDecision.decision === "dry-run") {
        return {
          success: true as const,
          result: { dryRun: true, skillId: skill.id },
          executionTimeMs: 0,
        };
      }
      // decision === "run" → fall through to execute.

      // Resolve the intelligence service from DB (workspace pref → user pref → default)
      const { endpoint: hubUrl, serviceApiKey: hubApiKey } =
        await resolveIntelligenceService({
          userId,
          workspaceId: skill.workspaceId ?? undefined,
        });

      let result: {
        success: boolean;
        result?: unknown;
        error?: string;
        executionTimeMs: number;
      };

      try {
        const response = await fetch(`${hubUrl}/api/skills/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": hubApiKey,
          },
          body: JSON.stringify({
            skillId: input.id,
            userId,
            parameters: input.input ?? {},
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Hub returned ${response.status}: ${text}`);
        }

        result = (await response.json()) as typeof result;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Skill execution failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Update execution metadata on success
      if (result.success) {
        const currentMeta =
          (skill.metadata as Record<string, unknown> | null) ?? {};
        const execCount =
          ((currentMeta.executionCount as number | undefined) ?? 0) + 1;
        await db
          .update(skills)
          .set({
            metadata: {
              ...currentMeta,
              executionCount: execCount,
              lastTestedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(skills.id, input.id));
      }

      return result;
    }),

  /**
   * Approve or revoke approval for a skill's execution. Owner-gated (workspace
   * owner, or pod-admin for pod-wide null-workspace skills) — mirrors
   * `mcpServersRouter.setApproved`. An unapproved skill is refused by the
   * backend/IS executor and is not loaded as an agent tool.
   */
  setApproved: protectedProcedure
    .input(z.object({ id: z.string().uuid(), approved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const existing = await ctx.db.query.skills.findFirst({
        where: eq(skills.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can approve skill execution.",
          });
        }
      } else {
        // Pod-wide (null-workspace) skill — pod-level privileged action.
        await requirePodAdmin(userId);
      }

      const [updated] = await db
        .update(skills)
        .set({ approved: input.approved, updatedAt: new Date() })
        .where(eq(skills.id, input.id))
        .returning();

      auditLog({
        subjectType: "skill",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existing.workspaceId || undefined,
        data: { approved: input.approved },
      });

      return { skill: updated };
    }),

  /**
   * Install a skill from a URL (SKILL.md or SKILL.toml format)
   *
   * Supports:
   *   - OpenClaw ClawHub skills (SKILL.md with YAML frontmatter)
   *   - ZeroClaw skills (SKILL.toml with companion markdown)
   *
   * The `code` field stores the instruction text.
   * `metadata.skillType = 'instruction'` tells the Intelligence Hub
   * to inject this skill's content into the agent system prompt rather
   * than executing it as code.
   */
  installFromUrl: protectedProcedure
    .input(
      z.object({
        url: z.string().url("Must be a valid URL"),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Fetch the remote skill file
      let rawContent: string;
      const fetchHeaders = {
        Accept: "text/plain, text/markdown, application/toml, */*",
      };
      try {
        // SSRF guard: validate every hop (including redirects) against internal
        // targets. No credentials are sent, so a small redirect budget preserves
        // the original redirect-following behaviour for skill hosts.
        const res = await safeExternalFetch(
          input.url,
          { headers: fetchHeaders },
          5
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        rawContent = await res.text();
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Failed to fetch skill from URL: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Parse as SKILL.md or SKILL.toml
      const isToml =
        input.url.endsWith(".toml") ||
        rawContent.trimStart().startsWith("[skill]");

      let parsed;
      if (isToml) {
        // For TOML manifests, try to load a companion SKILL.md at the same URL base.
        // Many ZeroClaw skills store the instruction markdown separately.
        let companionMarkdown: string | undefined;
        // Build companion URL: replace .toml extension, or append .md for extension-less URLs
        const companionUrl = input.url.endsWith(".toml")
          ? input.url.replace(/\.toml$/i, ".md")
          : `${input.url}.md`;
        try {
          const companionRes = await safeExternalFetch(
            companionUrl,
            { headers: fetchHeaders },
            5
          );
          if (companionRes.ok) {
            const ct = companionRes.headers.get("content-type") ?? "";
            // Only accept text responses (markdown, plain text) — reject HTML/JSON/binary
            if (ct.includes("text/") || ct === "") {
              companionMarkdown = await companionRes.text();
              // Sanity check: ignore if it looks like an HTML error page
              if (companionMarkdown.trimStart().startsWith("<!")) {
                companionMarkdown = undefined;
              }
            }
          }
        } catch {
          // Non-fatal — inline instructions in TOML are the fallback
        }
        parsed = parseSkillToml(rawContent, companionMarkdown);
      } else {
        parsed = parseSkillMd(rawContent);
      }

      if (!parsed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not parse the skill file. Expected SKILL.md (YAML frontmatter + markdown) or SKILL.toml format.",
        });
      }

      if (!parsed.instructions.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Skill has no instructions. Please check the skill file content.",
        });
      }

      // Check if a skill with this name already exists for this user+workspace
      const existing = await db.query.skills.findFirst({
        where: and(
          eq(skills.userId, userId),
          eq(skills.workspaceId, input.workspaceId),
          eq(skills.name, parsed.name)
        ),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A skill named '${parsed.name}' is already installed. Delete it first or install under a different name.`,
        });
      }

      // Store skill — instruction content goes in `body` (the canonical doc column).
      // `code` is the executable JS/TS column; instruction skills have none.
      // Persistence + approval gating goes through the ONE governed door
      // (insertSkillGoverned) — never a direct insert with a hardcoded
      // `approved: true` (that was the prompt-injection hole this closes).
      const result = await insertSkillGoverned({
        userId,
        workspaceId: input.workspaceId,
        kind: "instruction",
        scope: "pod",
        name: parsed.name,
        description: parsed.description,
        body: parsed.instructions,
        code: null,
        category: "instruction",
        executionMode: "sync",
        metadata: {
          source: parsed.source,
          version: parsed.version,
          installedFromUrl: input.url,
          dependencies: parsed.dependencies,
        },
        auditSource: "install_from_url",
      });

      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }
      if (result.status === "proposed") {
        return {
          status: "proposed" as const,
          proposalId: result.proposalId,
        };
      }

      return {
        id: result.skill.id,
        name: result.skill.name,
        status: "installed" as const,
        kind: "instruction" as const,
        source: parsed.source,
        version: parsed.version,
      };
    }),

  /**
   * The tools a skill requires (`skill → requires → tool` edges) + the skill.
   * Powers the skill detail page and the editor's tool-attach UI.
   */
  getRequiredTools: protectedProcedure
    .input(z.object({ skillId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.skillId),
          // Pod-scoped: any user. User/workspace-scoped: owner only. Same floor
          // as skills.get — without it, any skillId leaks its required-tool edges.
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });
      if (!skill)
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      const edges = await getLinksFor(userId, "skill", input.skillId);
      const toolIds = edges
        .filter((e) => e.linkType === "requires" && e.toType === "tool")
        .map((e) => e.toId);
      const requiredTools = toolIds.length
        ? await db.select().from(tools).where(inArray(tools.id, toolIds))
        : [];
      return { skill, tools: requiredTools };
    }),

  /**
   * Replace the set of tools a skill requires. Diffs against existing `requires`
   * edges — adds new, removes dropped. (One skill ↔ many tools.) Idempotent.
   */
  setRequiredTools: protectedProcedure
    .input(
      z.object({
        skillId: z.string().uuid(),
        toolIds: z.array(z.string().uuid()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.skillId),
          // Owner floor before editing the skill's `requires` edges — same gate
          // as getRequiredTools / skills.get. Pod-scoped skills stay editable by
          // any user (existing model); user-scoped skills are owner-only.
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });
      if (!skill)
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });

      const edges = await getLinksFor(userId, "skill", input.skillId);
      const existing = edges.filter(
        (e) => e.linkType === "requires" && e.toType === "tool"
      );
      const existingIds = new Set(existing.map((e) => e.toId));
      const wanted = new Set(input.toolIds);

      // Remove edges no longer wanted.
      for (const e of existing) {
        if (!wanted.has(e.toId)) await deleteLink(e.id);
      }
      // Add new edges.
      const toAdd = input.toolIds.filter((id) => !existingIds.has(id));
      if (toAdd.length) {
        await createLinks(
          toAdd.map((toolId) => ({
            workspaceId: skill.workspaceId ?? null,
            fromType: "skill" as const,
            fromId: input.skillId,
            toType: "tool" as const,
            toId: toolId,
            linkType: "requires" as const,
          }))
        );
      }
      return { skillId: input.skillId, toolIds: input.toolIds };
    }),
});
