/**
 * MCP tool handlers — capability domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { verifyWorkspaceAccess } from "../../hub-protocol/rest/_shared.js";
import { skillsRouter as regularSkillsRouter } from "../../skills.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { validateCreateVerbInput } from "../validate-create-verb.js";
import { wireCreatedVerb } from "../../../services/capabilities/create-declarative-verb.js";
import {
  db,
  tools as toolsTable,
  eq,
  and,
  or,
  isNull,
  type ProviderVerbSpec,
} from "@synap/database";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import {
  ok,
  requireScope,
  PROPERTY_VALUE_TYPES,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

export const capabilityHandlers: McpHandlerMap = {
  synap_define_role: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const applicableKinds =
      Array.isArray(args.applicableKinds) && args.applicableKinds.length > 0
        ? (args.applicableKinds as string[])
        : ["company", "person"];
    const uiHints: Record<string, unknown> = {};
    if (typeof args.icon === "string") uiHints.icon = args.icon;
    if (typeof args.description === "string")
      uiHints.description = args.description;
    const result = await caller.profiles.createProfile({
      userId,
      // Confined workspace (service-key clamp) — not the raw model-supplied id.
      workspaceId: requestedWorkspaceId as string,
      slug: args.slug as string,
      displayName: args.displayName as string,
      profileKind: "role",
      applicableKinds,
      ...(typeof args.roleCategory === "string"
        ? { roleCategory: args.roleCategory }
        : {}),
      ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
      ...(args.properties
        ? { defaultValues: args.properties as Record<string, unknown> }
        : {}),
      reasoning: "Role type defined via MCP synap_define_role",
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_define_kind: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);

    // `properties` means DEFAULT VALUES on synap_define_role and FIELD DEFS
    // here. Fail loudly on the role-shaped object instead of silently
    // dropping the caller's fields.
    if (args.properties !== undefined && !Array.isArray(args.properties)) {
      return ok({
        error:
          "synap_define_kind: `properties` must be an ARRAY of field definitions ({ slug, valueType }). To set default VALUES for new entities of this kind, use `defaultValues` instead.",
      });
    }

    const uiHints: Record<string, unknown> = {};
    if (typeof args.icon === "string") uiHints.icon = args.icon;
    if (typeof args.description === "string")
      uiHints.description = args.description;

    const declaredEntityScope =
      args.entityScope === "pod" || args.entityScope === "workspace"
        ? args.entityScope
        : undefined;

    const result = await caller.profiles.createProfile({
      userId,
      // Confined workspace (service-key clamp) — not the raw model-supplied id.
      workspaceId: requestedWorkspaceId as string,
      slug: args.slug as string,
      displayName: args.displayName as string,
      profileKind: "kind",
      ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
      ...(args.defaultValues
        ? { defaultValues: args.defaultValues as Record<string, unknown> }
        : {}),
      ...(declaredEntityScope ? { entityScope: declaredEntityScope } : {}),
      reasoning: "Entity kind defined via MCP synap_define_kind",
      ...(agentUserId ? { agentUserId } : {}),
    });

    const propertySpecs = (args.properties ?? []) as Array<
      Record<string, unknown>
    >;

    // Governance gated the profile itself → there is no profileId to hang
    // fields on. Return the proposal and tell the caller the fields are still
    // pending, rather than half-applying a schema.
    if (
      result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "proposed"
    ) {
      return ok({
        ...result,
        ...(propertySpecs.length > 0
          ? {
              properties: {
                status: "deferred",
                message:
                  "The kind itself is awaiting review. Re-call synap_define_kind with the same slug once the proposal is approved to add these fields (the call is slug-idempotent).",
                pending: propertySpecs.length,
              },
            }
          : {}),
      });
    }

    const createdProfile = result.profile as {
      id?: string;
      slug?: string;
    } | null;
    const profileId = createdProfile?.id;

    if (propertySpecs.length === 0 || !profileId) {
      return ok(result);
    }

    const properties: Array<Record<string, unknown>> = [];
    for (const spec of propertySpecs) {
      const propSlug = typeof spec.slug === "string" ? spec.slug : undefined;
      const valueType =
        typeof spec.valueType === "string" ? spec.valueType : undefined;
      if (!propSlug || !valueType) {
        properties.push({
          slug: propSlug ?? null,
          status: "error",
          error: "Each property requires `slug` and `valueType`.",
        });
        continue;
      }
      // The hub door types valueType as `z.string()` and then casts it onto
      // the `property_defs.value_type` PG enum, so an unknown string fails at
      // INSERT time with a Postgres error the agent cannot act on. The enum
      // is PropertyValueType in packages/database/src/schema/property-defs.ts.
      if (!PROPERTY_VALUE_TYPES.includes(valueType)) {
        properties.push({
          slug: propSlug,
          status: "error",
          error: `Unsupported valueType '${valueType}'. Valid: ${PROPERTY_VALUE_TYPES.join(", ")}.`,
        });
        continue;
      }
      try {
        const propResult = await caller.profiles.createPropertyDef({
          userId,
          workspaceId: requestedWorkspaceId as string,
          profileId,
          slug: propSlug,
          valueType,
          ...(spec.constraints
            ? { constraints: spec.constraints as Record<string, unknown> }
            : {}),
          ...(spec.uiHints || spec.displayName
            ? {
                uiHints: {
                  ...((spec.uiHints as Record<string, unknown>) ?? {}),
                  ...(typeof spec.displayName === "string"
                    ? { displayName: spec.displayName }
                    : {}),
                },
              }
            : {}),
          ...(typeof spec.required === "boolean"
            ? { required: spec.required }
            : {}),
          ...(spec.defaultValue !== undefined
            ? { defaultValue: spec.defaultValue }
            : {}),
          ...(typeof spec.displayOrder === "number"
            ? { displayOrder: spec.displayOrder }
            : {}),
          ...(spec.overlay === true ? { overlay: true } : {}),
          reasoning: `Field of kind '${args.slug}' defined via MCP synap_define_kind`,
          ...(agentUserId ? { agentUserId } : {}),
        });
        properties.push({ slug: propSlug, ...propResult });
      } catch (err) {
        // One rejected field must not discard the fields that did land — the
        // caller gets a per-field ledger and can retry just the failures.
        properties.push({
          slug: propSlug,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return ok({ ...result, properties });
  },
  synap_governance: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const wsId = args.workspaceId as string;
    // Membership floor: getEffectiveGovernance reads ANY workspace's policy by
    // id, so gate on the caller actually belonging to it (a bound service key
    // is already clamped upstream; this closes the read for ordinary keys too).
    if (wsId && !(await verifyWorkspaceAccess(userId, wsId))) {
      return ok({ error: `Forbidden: no access to workspace ${wsId}` });
    }
    const { getEffectiveGovernance } =
      await import("../../../utils/permission-check.js");
    const { countPendingProposals } =
      await import("../../../services/proposals/proposals-service.js");
    const policy = await getEffectiveGovernance(wsId);
    const pendingCount = await countPendingProposals(wsId);
    return ok({ ...policy, pendingProposals: pendingCount });
  },
  synap_list_capabilities: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const wsId = args.workspaceId as string;
    const query =
      typeof args.query === "string" && args.query.trim().length > 0
        ? args.query
        : undefined;
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;

    // ── INTENT LOOKUP (the reverse index) ─────────────────────────────────
    // "Which installed capability can send a message?" answered WITHOUT the
    // caller knowing the vendor. Routing only: it returns CONCRETE verb ids,
    // which `synap_run_capability` then governs exactly as before.
    if (args.intent !== undefined) {
      const { isAbstractVerb, ABSTRACT_VERBS } =
        await import("@synap/database/schema");
      if (!isAbstractVerb(args.intent)) {
        return ok({
          error:
            `Unknown intent ${JSON.stringify(args.intent)}. The vocabulary is closed — ` +
            `one of: ${ABSTRACT_VERBS.join(", ")}.`,
        });
      }
      const { capabilitiesByIntent } =
        await import("../../../services/capabilities/capability-intent-index.js");
      const matches = await capabilitiesByIntent(
        { workspaceId: wsId, userId },
        args.intent
      );
      return ok({
        intent: args.intent,
        matches,
        // Empty is a real answer, not silence — say so, the same way the
        // zero-hit rescue below refuses to hand back a bare [].
        ...(matches.length === 0
          ? {
              note:
                `No visible capability declares the intent "${args.intent}". Not every installed ` +
                `verb declares one yet — call synap_list_capabilities without \`intent\` to scan the full catalog ` +
                `before concluding the pod cannot do this.`,
            }
          : {}),
      });
    }
    const { listCapabilities, sectionCapabilities, DEFAULT_QUERY_LIMIT } =
      await import("../../../services/capabilities/capability-registry.js");
    // `limit: null` — never slice the RAW flat list here when a `query` is
    // set. This result is handed to `sectionCapabilities` below, which
    // dedupes (a provider installed twice, N backing-skill copies of one
    // verb); slicing before that fold could push a genuine match out of the
    // window behind duplicate rows of something else, so an agent could
    // conclude a capability does not exist when it does. Cap AFTER dedup
    // instead (see the `sections =` cap below). Same fix as the tRPC
    // `capabilities.sections` door (`routers/capabilities.ts`).
    let capabilities = await listCapabilities(
      { workspaceId: wsId, userId },
      query || kind || limit !== undefined
        ? {
            query,
            kind: kind as never,
            // Always `null` here — whatever cap applies (the caller's
            // explicit `limit`, or the `DEFAULT_QUERY_LIMIT` fallback) is
            // applied post-dedup below, never by slicing this raw list.
            limit: null,
          }
        : undefined
    );

    // ── ZERO-HIT RESCUE ───────────────────────────────────────────────────
    // `query` ranks by scoreTextMatch, which is pure lowercase SUBSTRING
    // matching, hard-filtered to score > 0 (capability-registry.ts). So a
    // semantically CORRECT query with no literal overlap — "web search",
    // "internet research", "look things up online" — returns the EMPTY SET
    // even when a matching capability is installed and enabled.
    //
    // Returning a bare [] hands the agent positive evidence of ABSENCE, and a
    // well-behaved agent then truthfully tells the user the pod cannot do the
    // thing it can in fact do. That is exactly how an installed, working
    // ExaSearch was reported as "not accessible" (2026-07-24).
    //
    // So: never answer a search with silence. Fall back to the unfiltered
    // catalog and SAY that the query matched nothing, so the model can scan
    // what actually exists instead of concluding the pod is incapable.
    let zeroHitNote: string | undefined;
    if (query && capabilities.length === 0) {
      capabilities = await listCapabilities(
        { workspaceId: wsId, userId },
        // Drop `query` (that's what matched nothing) but keep the kind filter
        // if the caller set one — they asked for a category, not this string.
        // `limit: null` for the same reason as the primary fetch above — an
        // explicit caller `limit` is still applied, but post-dedup below.
        kind || limit !== undefined
          ? { kind: kind as never, limit: null }
          : undefined
      );
      zeroHitNote =
        `No capability NAME, verb label, or description literally contains "${query}" ` +
        `(matching is substring-based, not semantic). That is NOT proof the pod cannot do this — ` +
        `the full list below is what IS available; scan it before concluding anything is impossible. ` +
        `If nothing fits, search the marketplace: synap_run_capability({ verbId: "market.search", parameters: { query: "..." } }).`;
    }

    // Agent-facing view: real, distinct, runnable capabilities grouped by
    // type with each integration's verbs nested — NOT the flat management dump
    // (which buries the ~20 real actions under 90+ built-in MCP tools + 100+
    // teaching docs + duplicate rows). See `sectionCapabilities`.
    //
    // Cap AFTER dedup, over distinct rows — the fix, mirrors the tRPC
    // `capabilities.sections` door. An explicit caller `limit` always wins;
    // otherwise fall back to `DEFAULT_QUERY_LIMIT`, but ONLY on the primary
    // query-hit path (`query && !zeroHitNote`) — the zero-hit rescue's whole
    // point is showing the agent the FULL catalog ("scan it before
    // concluding anything is impossible", above), so it must stay unbounded.
    //
    // ONE DELIBERATE DIVERGENCE from the tRPC door: this adapter never
    // forwards `sections.builtins` (see the comment on `excluded` below —
    // over MCP a built-in is already a native tool, so listing it again here
    // is a weaker duplicate). The comment right above already names built-ins
    // as the noise that buries "the ~20 real actions" — so letting them
    // compete for the SAME ranked budget as integrations/skills/commands
    // would starve the only rows this door actually returns, for a section
    // it never shows. Rank/cap the FORWARDED kinds only; builtins (and the
    // `excluded` counts) are read from a second, unbounded fold of the exact
    // same `capabilities` list — same fold, same dedupe rule, just not
    // competing for the same slice budget.
    //
    // ── AN EXPLICIT `kind` ASK OVERRIDES THE DEFAULT FOLD ─────────────────
    // Everything above is about the DEFAULT view, and it stays. But the fold
    // was applied unconditionally, so a caller that deliberately named one of
    // the folded kinds got `{integrations:[], skills:[], commands:[],
    // excluded:{teachingDocs:N}}` — the door counted the rows, refused to list
    // them, and pointed at a `kind:"builtin-tool"` hatch that returned nothing
    // either, because the built-in filter on the next line ran regardless of
    // what was asked. A count is not an answer to "list these"; naming a kind
    // IS the caller taking responsibility for the noise.
    const askedForBuiltins = kind === "builtin-tool";
    const askedForTeachingDocs = kind === "teaching-doc";

    const cappedInput = askedForBuiltins
      ? capabilities
      : capabilities.filter((c) => c.kind !== "builtin-tool");
    const sections = sectionCapabilities(cappedInput, {
      limit: limit ?? (query && !zeroHitNote ? DEFAULT_QUERY_LIMIT : undefined),
    });
    const fullSections = sectionCapabilities(capabilities);

    // Teaching docs never land in ANY section (`sectionCapabilities` folds
    // them to a count), so an explicit ask is served by projecting the flat
    // rows here. Deduped on the ref the caller would open — the same "same
    // row" rule the sections use, applied to the identity that matters for a
    // doc — and capped by the caller's own `limit` when they set one.
    const allTeachingDocs = askedForTeachingDocs
      ? [
          ...new Map(
            capabilities
              .filter((c) => c.kind === "teaching-doc")
              .map((c) => [c.slug ?? c.id, c])
          ).values(),
        ]
      : [];
    const teachingDocs = allTeachingDocs
      .slice(0, limit ?? allTeachingDocs.length)
      .map((c) => ({
        id: c.id,
        // What `synap_load_skill` takes. `null` only for a legacy row with no
        // slug — surfaced as null rather than silently swapped for the name,
        // which is not a ref any door resolves.
        ref: c.slug ?? null,
        name: c.name,
        description: c.description ?? null,
      }));

    return ok({
      integrations: sections.integrations,
      skills: sections.skills,
      commands: sections.commands,
      ...(askedForBuiltins ? { builtins: sections.builtins } : {}),
      ...(askedForTeachingDocs ? { teachingDocs } : {}),
      // Honest, not hidden: these were folded out of the actionable view.
      //
      // `sections.builtins` now carries built-in tools as real ROWS (the
      // human catalogue renders them as a collapsed section). This adapter
      // deliberately does NOT forward them: over MCP a built-in already IS a
      // native tool the caller can invoke directly, so listing it again here
      // would be a second, weaker copy of something already in reach. The
      // asymmetry is the correct answer, not a gap — but the COUNT must
      // survive, or an agent loses the signal that anything was folded out.
      excluded: {
        ...sections.excluded,
        // Count what was actually WITHHELD, never what merely got folded by
        // the default. When the caller asked for the kind, the rows above are
        // the answer and only the `limit` remainder is still excluded —
        // reporting the full count next to the rows themselves was the same
        // "the door says one thing and does another" defect being fixed here.
        ...(askedForTeachingDocs
          ? { teachingDocs: allTeachingDocs.length - teachingDocs.length }
          : {}),
        // From the UNBOUNDED fold — when built-ins are NOT forwarded they
        // never entered `cappedInput`, so `sections.builtins` is empty and
        // would undercount every built-in the ranked cap never saw.
        builtinTools: fullSections.builtins.length - sections.builtins.length,
        note:
          "Core built-in tools are already available to you directly as MCP tools; teaching docs are prose, not actions — both are folded out of this actionable view by DEFAULT. " +
          'Pass kind:"builtin-tool" or kind:"teaching-doc" to list them here instead, ' +
          'or call synap_load_skill("catalog") for every teaching doc grouped by topic (your own authored skills included, under "yours").',
      },
      ...(zeroHitNote ? { note: zeroHitNote } : {}),
    });
  },
  synap_run_capability: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      requestedWorkspaceId,
      sessionId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Confined workspace (service-key clamp) — not the raw model-supplied id.
    const wsId = requestedWorkspaceId as string;
    const { executeCapability } =
      await import("../../../services/capabilities/execute-capability.js");
    const outcome = await executeCapability({
      // Idempotency: a retried capability run resolves to the prior run's
      // proposal/result rather than firing twice. (Direct external-send verbs
      // still carry the residual double-send gap — see the decision below.)
      idempotencyKey: args.idempotencyKey as string | undefined,
      verbId: args.verbId as string | undefined,
      skillId: args.skillId as string | undefined,
      parameters: args.parameters as Record<string, unknown> | undefined,
      workspaceId: wsId,
      userId,
      // Thread the acting agent (set on agent-key remap) so an agent WRITE verb
      // is governed by grant/propose — consistent with every other write proc
      // in this adapter. Omitting it laundered agent writes into operator runs.
      agentUserId: agentUserId ?? null,
      // Ambient focus session of this MCP turn (X-Session-Id → ctx.sessionId,
      // the SAME source synap_create_verb reads). Lands on the resulting
      // `capability.run` proposal's session_id column; null outside a session.
      sessionId: sessionId ?? null,
    });
    // Surface the same discriminated outcome the hub door returns, in a shape
    // the agent reads naturally (proposed is NOT an error). A `kind:"error"`
    // (the verb ran and its handler failed) surfaces as an error to the agent —
    // the adapter's `{ error }` convention — not a success payload.
    if (outcome.kind === "error") {
      // `errorClass`/`providerRef` ride ALONGSIDE the human message (set when the
      // failure came from a provider dispatch). Without them this agent-facing
      // door cannot tell a retryable provider blip from a credential expiry that
      // needs a reconnect — the same signal the Hub door surfaces on its 424.
      return ok({
        error: outcome.message,
        ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
        // CONNECTION moment — a no_connection/auth failure carries the link to
        // the card where the account is connected. Without this the `errorClass`
        // told the agent WHAT kind of failure it was and nothing about where to
        // fix it, which is the same dead end the deny path had.
        ...(outcome.enable ? { enable: outcome.enable } : {}),
      });
    }
    return ok(outcome);
  },
  synap_create_verb: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, sessionId } =
      ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);

    // Hard constraints 1 (declarative-only) + 2's field shape are enforced
    // in a pure, unit-tested helper — see validate-create-verb.test.ts.
    const validated = validateCreateVerbInput(args);
    if (!validated.ok) {
      return ok({ error: validated.error });
    }
    const input = validated.data;

    // Hard constraint 2: toolName must ALREADY be installed/credentialed for
    // the caller (pod-wide, or the given workspace) — this door only ADDS a
    // verb to an existing tool. It never creates a tool/connection as a
    // side effect.
    const wsLens = input.workspaceId
      ? or(
          isNull(toolsTable.workspaceId),
          eq(toolsTable.workspaceId, input.workspaceId)
        )
      : isNull(toolsTable.workspaceId);
    const [existingTool] = await db
      .select({ id: toolsTable.id, name: toolsTable.name })
      .from(toolsTable)
      .where(
        and(
          eq(toolsTable.name, input.toolName),
          wsLens,
          userVisibleWhere(toolsTable.workspaceId, userId)
        )
      )
      .limit(1);
    if (!existingTool) {
      return ok({
        error:
          `Tool '${input.toolName}' is not installed` +
          `${input.workspaceId ? ` for workspace ${input.workspaceId}` : ""}. ` +
          `synap_create_verb only adds a verb to an ALREADY-installed, credentialed tool — ` +
          `install/connect '${input.toolName}' first, or check the exact name via synap_list_capabilities.`,
      });
    }

    // Hard constraint 4: reuse the canonical ProviderVerbSpec shape
    // verbatim (@synap/database schema/skills.ts) — no invented field names.
    const providerSpec: ProviderVerbSpec = {
      tool: input.toolName,
      method: input.method,
      pathTemplate: input.pathTemplate,
      ...(input.transport ? { transport: input.transport } : {}),
      ...(input.graphql ? { graphql: input.graphql } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.responseShape ? { responseShape: input.responseShape } : {}),
    };

    // Hard constraint 3: reuse the SAME governed door POST /skills uses
    // (skillsRouter.create) — checkPermissionOrPropose runs INSIDE it. No
    // bypass flag, no direct db.insert here.
    const skillsCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      input.workspaceId ?? null,
      undefined,
      sessionId,
      agentUserId ?? null
    );
    const skillsCaller = regularSkillsRouter.createCaller(skillsCtx as never);
    const result = await skillsCaller.create({
      workspaceId: input.workspaceId,
      kind: "declarative",
      scope: input.workspaceId ? "workspace" : "pod",
      name: input.verbName,
      description: input.description,
      providerSpec: providerSpec as unknown as Record<string, unknown>,
      parameters: input.parameters,
      // Fixed alongside this tool: skills.create's own checkPermissionOrPropose
      // call was missing agentUserId entirely (no input field for it existed),
      // so an agent-initiated create was evaluated as if the human owner did
      // it directly. Now threaded through, mirroring entities.ts's pattern.
      agentUserId: agentUserId ?? undefined,
    });

    // WIRING — the MCP door used to write NONE of the edges the tRPC door
    // writes, so an agent-authored verb was born ORPHANED (invisible under its
    // tool, on its card, in the Bricks registry). Same SHARED `wireCreatedVerb`
    // both doors call now, on the same governed context used for the create.
    // Only on `created`; a `proposed` skill row does not exist yet.
    const wiring =
      result.status === "created"
        ? await wireCreatedVerb(skillsCtx as never, {
            skillId: result.id,
            parentToolId: existingTool.id,
            verbName: input.verbName,
            ...(input.description ? { description: input.description } : {}),
            parameters: input.parameters,
          })
        : { requires: false, catalogued: false, capabilityIds: [] };

    return ok({ ...result, wiring });
  },
  synap_list_automations: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // Same door the IS/UI use (hubAutomationsRouter.listAutomations →
    // automationsRouter.list): access-layer visibility floor + pod-wide globals,
    // narrowed by the workspace lens when present. No lens → all accessible.
    const result = await caller.automations.listAutomations({
      userId,
      workspaceId: requestedWorkspaceId ?? null,
      status: args.status as
        "draft" | "active" | "paused" | "error" | undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return ok(result);
  },
  synap_trigger_automation: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (typeof args.id !== "string" || args.id.trim() === "") {
      return ok({ error: "id (automation UUID) is required" });
    }
    // Mirror the EXISTING trigger path exactly (hubAutomationsRouter.trigger
    // Automation → automationsRouter.trigger): identified by id, gated by
    // assertWorkspaceWrite on the automation's REAL workspace, then enqueued.
    // A RUN is CODE EXECUTION: `automation.execute` is NOT in
    // DEFAULT_AUTO_APPROVE, so when `agentUserId` is present (i.e. an AGENT is
    // asking) `automations.trigger` routes through `checkPermissionOrPropose`
    // and returns `{ status: "proposed", proposalId }` — see
    // routers/automations.ts:1145-1172. On approval the `automation/execute`
    // proposal executor re-triggers as the APPROVER with no agentUserId, which
    // takes the operator branch and actually enqueues the run.
    // (An operator-initiated call — no agentUserId — is DIRECT and returns
    // `{ status: "triggered", runId }`.)
    // The entity writes the run performs downstream
    // are separately governed by the automation-governance gate keyed off the
    // automation's OWNING agent (checkAutomationWriteOrPropose), so an agent
    // launching a run never launders those writes past governance.
    // Workspace scoping: pass the confined lens (requestedWorkspaceId) — the
    // trigger proc rejects a mismatch, so a lens-scoped call only fires that
    // lens's automations; call with no workspace lens to run a pod-wide one.
    const result = await caller.automations.triggerAutomation({
      userId,
      workspaceId: requestedWorkspaceId ?? null,
      id: args.id,
      payload: args.payload as Record<string, unknown> | undefined,
      agentUserId: agentUserId ?? undefined,
    });
    return ok(result);
  },
  synap_create_automation: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (typeof args.name !== "string" || args.name.trim() === "") {
      return ok({ error: "name is required" });
    }
    if (typeof args.triggerType !== "string") {
      return ok({
        error: "triggerType is required (event | cron | webhook | manual)",
      });
    }
    const flow = args.flowDefinition as
      { nodes?: unknown; edges?: unknown } | undefined;
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
      return ok({
        error:
          "flowDefinition is required and must be { nodes: [...], edges: [...] }",
      });
    }
    // ── Capability-step validation (BEFORE the governance gate) ────────────
    // A `capability` node names a VERB; nothing used to check that the verb
    // exists, so an agent could create an automation whose step calls a verb
    // that was never installed — it then fails (or silently does nothing) at
    // run time. Resolve every capability step against what THIS CALLER can
    // see, through the same access-scoped `listCapabilities` registry door
    // `synap_list_capabilities` uses, so a flow can never be validated against
    // capabilities the caller cannot see.
    //
    // This runs BEFORE `createAutomation`, i.e. before governance: a bad flow
    // is rejected on its MERITS, and a `status:"proposed"` result (a success —
    // the write is queued for review) is never turned into an error.
    {
      const { validateFlowCapabilities } =
        await import("../validate-automation-flow.js");
      const flowVerdict = await validateFlowCapabilities(flow.nodes, {
        loadIndex: async () => {
          const { listCapabilities } =
            await import("../../../services/capabilities/capability-registry.js");
          const caps = await listCapabilities({
            workspaceId: requestedWorkspaceId ?? null,
            // The EXECUTION identity, not the bearer. `automations.create` sets
            // `createdBy = agentUserId ?? ctx.userId`, and at run time a
            // capability node resolves under that owner — `visibleSkillsWhere`
            // has a per-user tier, so validating as the human would both
            // FALSE-REJECT an agent-owned user-scoped skill and FALSE-ACCEPT a
            // human-owned one that then throws "not found" mid-run. Keep this
            // expression identical to the `createdBy` one below.
            userId: agentUserId ?? userId,
          });
          const verbIds = new Set<string>();
          const capabilityIds = new Set<string>();
          for (const cap of caps) {
            capabilityIds.add(cap.id);
            // Two resolution paths, both real: the process builder picks a
            // verb out of a tool's verb catalog (`ToolVerbCatalogEntry.id`),
            // and `executeCapability` resolves a bare verbId against
            // `skills.name`. A skill row surfaces here as a `skill` /
            // `teaching-doc` capability whose `name` IS that skill name.
            for (const verb of cap.verbs ?? []) verbIds.add(verb.id);
            if (cap.kind === "skill" || cap.kind === "teaching-doc") {
              verbIds.add(cap.name);
            }
          }
          return { verbIds, capabilityIds };
        },
        // Best-effort suggestion: the pod-local Control-Plane catalog cache —
        // the SAME read the `market.search` builtin verb performs. Failure,
        // timeout or an empty result degrades to silence; the validation
        // error still stands and nothing is ever auto-installed.
        searchMarketplace: async (verbId) => {
          const { queryCatalogCache } =
            await import("../../../services/capabilities/catalog-cache-query.js");
          let rows = await queryCatalogCache({
            query: verbId,
            kind: "capability",
            limit: 3,
          });
          // Catalog matching is literal substring, so a namespaced verb
          // ("gmail.send") rarely matches a package NAME. Retry on the
          // namespace segment, which usually IS the provider's name.
          const ns = verbId.includes(".") ? verbId.split(".")[0] : "";
          if (rows.length === 0 && ns) {
            rows = await queryCatalogCache({
              query: ns,
              kind: "capability",
              limit: 3,
            });
          }
          return rows.map((r) => ({
            slug: r.slug,
            name: r.name,
            kind: r.kind,
          }));
        },
      });
      if (!flowVerdict.ok) return ok({ error: flowVerdict.error });
    }

    // resultRouting (optional) threads into metadata.resultRouting — the SET
    // path for the per-entity/per-type run routing. We build the FULL metadata
    // bag here (a create, not an update), so no wholesale-replace hazard.
    const resultRouting = args.resultRouting as
      "per_type" | "per_entity" | "trigger" | undefined;
    const metadata: Record<string, unknown> = {
      ...((args.metadata as Record<string, unknown> | undefined) ?? {}),
      ...(resultRouting ? { resultRouting } : {}),
    };
    // GOVERNED create (hubAutomationsRouter.createAutomation → automationsRouter
    // .create). With agentUserId set, create routes through checkPermission
    // OrPropose → status:"proposed" (no row written); on approval the approve-
    // executor re-runs create and materializes a real automation. Default
    // status "active" (not draft) so an approved automation is immediately
    // live — mirrors synap_create_playbook.
    const result = await caller.automations.createAutomation({
      userId,
      agentUserId: agentUserId ?? undefined,
      // Provenance is branded by the hub createAutomation door itself
      // (source: agentUserId ? "agent" : "intelligence" → createdVia:"ai"),
      // so the MCP caller passes agentUserId and needs no explicit source.
      workspaceId: requestedWorkspaceId ?? null,
      name: args.name,
      description: args.description as string | undefined,
      triggerType: args.triggerType as "event" | "cron" | "webhook" | "manual",
      triggerConfig:
        (args.triggerConfig as Record<string, unknown> | undefined) ?? {},
      flowDefinition: flow as {
        nodes: Record<string, unknown>[];
        edges: Record<string, unknown>[];
      },
      status:
        (args.status as "draft" | "active" | "paused" | "error" | undefined) ??
        "active",
      metadata,
    });
    return ok(result);
  },
};
