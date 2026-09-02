/**
 * MCP tool handlers — capture domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { createHash } from "crypto";
import {
  db,
  knowledgeKeysRepository,
  entities,
  eq,
  and,
  isNull,
  resolveIdentity,
  extractIdentitySignals,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
} from "@synap/database";
import { logger } from "../../hub-protocol/rest/_shared.js";
import { describeAiFailure } from "../../../utils/ai-failure.js";
import { ownerPrivateVisibleWhere } from "../../../utils/user-visible-where.js";
import { accessScopeWhere } from "../../../utils/project-scope.js";
import { validateCaptureGraphRefs } from "../../hub-protocol/rest/_capture-graph-dedup.js";
import {
  ok,
  requireScope,
  CaptureScope,
  CaptureWriteReceipt,
  CAPTURE_CROSSKIND_PRECHECK_MAX,
  normalizeCaptureText,
  hasDurableText,
  hasDurableEntity,
  captureRejected,
  listMemberWorkspacesForAgent,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
  McpToolHandler,
} from "./shared.js";

const captureHandler: McpToolHandler = async (
  ctx: McpToolContext
): Promise<CallToolResult> => {
  const {
    toolName,
    args,
    userId,
    apiKeyScopes,
    agentUserId,
    sessionId,
    requestedWorkspaceId,
    confinedWorkspaceId,
    workspaceAccessible,
  } = ctx;
  requireScope(apiKeyScopes, "mcp.write", toolName);

  const captureRawText = typeof args.text === "string" ? args.text : "";
  const captureNormalizedText = normalizeCaptureText(captureRawText);
  const captureEntities = Array.isArray(args.entities)
    ? (args.entities as Array<Record<string, unknown>>)
    : [];
  const captureRelations = Array.isArray(args.relations)
    ? (args.relations as Array<Record<string, unknown>>)
    : [];
  const captureProjectId =
    typeof args.projectId === "string" && args.projectId
      ? args.projectId
      : null;
  // Project NAME-ref (piece D): an agent may name a project instead of
  // knowing its UUID (`projectName`, or `project: { name }`). Resolved at the
  // submitCaptureGraph boundary via an EXACT slug match on the caller's OWN
  // projects — no match is NEVER auto-linked (widening-access law).
  const captureProjectName =
    typeof args.projectName === "string" && args.projectName
      ? args.projectName
      : args.project &&
          typeof args.project === "object" &&
          typeof (args.project as { name?: unknown }).name === "string"
        ? (args.project as { name: string }).name
        : null;

  // `global` is the pod-wide RUNBOOK lane — a keyed text doc, not entities.
  // Mixing it with a structured payload has no meaning; say so rather than
  // silently dropping one of the two.
  if (args.global === true && captureEntities.length > 0) {
    return ok({
      error:
        "global:true is the pod-wide runbook lane and takes `text` only. Send the runbook text on its own call, or drop `global` to capture entities[].",
    });
  }

  // ══ STRUCTURED / GRAPH BRANCH ═══════════════════════════════════════════
  // Reaches the SAME core `POST /api/hub/capture/graph` calls — the mature,
  // idempotent `submitCaptureGraph` (within-batch collapse → identity dedup →
  // one `import.graph` proposal). The adapter-side work is only the ref
  // validation the HTTP door does in its handler (the core documents that
  // callers MUST have validated refs) and the membership check
  // `resolveActingContext` performs there.
  //
  // `text` sent ALONGSIDE `entities[]` is not dropped: the structured payload
  // wins (it is the precise one) and the raw text rides along as `rawSource`
  // provenance on the proposal, where the reviewer can see it.
  if (captureEntities.length > 0) {
    // Refs must be unique, and every relation ref must name an entity in
    // this call — fail loud, exactly like the HTTP door: a dangling ref would
    // silently drop the link at materialization time.
    //
    // DRIFT vs the old `synap_capture_graph`: `ref` is now OPTIONAL. A single
    // structured entity should not have to invent a local id. Auto-assign is
    // DOOR-LOCAL (it runs before the shared uniqueness/dangling validation);
    // `explicitRefs` only guards the minted ids against collision (a
    // duplicate EXPLICIT ref is caught by `validateCaptureGraphRefs` below).
    const explicitRefs = new Set<string>();
    for (const e of captureEntities) {
      if (typeof e.ref === "string" && e.ref) explicitRefs.add(e.ref);
    }
    let autoRefSeq = 0;
    const graphEntities: Array<Record<string, unknown> & { ref: string }> =
      captureEntities.map((e) => {
        if (typeof e.ref === "string" && e.ref) return { ...e, ref: e.ref };
        let candidate = `e${autoRefSeq++}`;
        while (explicitRefs.has(candidate)) candidate = `e${autoRefSeq++}`;
        explicitRefs.add(candidate);
        return { ...e, ref: candidate };
      });
    for (const e of graphEntities) {
      if (typeof e.profileSlug !== "string" || !e.profileSlug) {
        return ok({
          error: `entity '${e.ref}' needs a \`profileSlug\` — discover slugs with synap_list_profiles`,
        });
      }
    }
    // Relation SHAPE (sourceRef/targetRef/type presence) stays door-local —
    // MCP-specific message with the field names the agent must supply.
    for (const r of captureRelations) {
      if (
        typeof r.sourceRef !== "string" ||
        typeof r.targetRef !== "string" ||
        typeof r.type !== "string" ||
        !r.type
      ) {
        return ok({
          error: "each relation needs `sourceRef`, `targetRef` and `type`",
        });
      }
    }
    // SHARED: ref-uniqueness + dangling-relation (the one door both surfaces
    // run). Rendered here with MCP's own wording (the extra "same call" hint).
    const refIssue = validateCaptureGraphRefs(
      graphEntities,
      captureRelations as Array<{ sourceRef: string; targetRef: string }>
    );
    if (refIssue) {
      return ok({
        error:
          refIssue.kind === "duplicate-ref"
            ? `duplicate entity ref: ${refIssue.ref}`
            : `relation references an unknown ref: ${refIssue.sourceRef} -> ${refIssue.targetRef}. Every ref must belong to an entity in the same call.`,
      });
    }

    // The RAW requested id, not the dropped-on-failure lens: a placement pin
    // must fail loud (Forbidden, below) rather than silently land pod-wide.
    const graphWsId = requestedWorkspaceId ?? null;
    const graphScope: CaptureScope = {
      workspaceId: graphWsId,
      projectId: captureProjectId,
      sessionId: sessionId ?? null,
    };

    // ── REJECT: no-durable-content ───────────────────────────────────────
    if (!graphEntities.some((e) => hasDurableEntity(e))) {
      return captureRejected({
        reason: "no-durable-content",
        scope: graphScope,
        message:
          "Nothing storable was sent — every entity was empty. Give each one at least a `title`, or `properties` (email / phone / website are strongest: they also dedup), or a `content` body, or an `existingEntityId` to link to.",
      });
    }

    // ── REJECT: already-known ────────────────────────────────────────────
    // Fires ONLY when the call would be a pure no-op: a SINGLE entity, no
    // relations, carrying nothing beyond its own identity signals, whose
    // strong signal (email/phone/website/handle/external-id — `extractIdentitySignals`
    // reads `website`, never a bare `url`) already resolves to
    // an existing entity. Anything richer is an ENRICHMENT or a LINK and is
    // let through — `submitCaptureGraph` reuses the existing row instead of
    // minting a duplicate, so there is nothing left to guard there.
    //
    // TITLE SIMILARITY NEVER REJECTS: no `name`/`userScope` is passed here,
    // so only the strong (globally-unique) path of the resolver runs.
    // Same-title-across-kinds stays advisory (crossKindCandidates, below).
    if (graphEntities.length === 1 && captureRelations.length === 0) {
      const only = graphEntities[0];
      const onlyProps =
        only.properties &&
        typeof only.properties === "object" &&
        !Array.isArray(only.properties)
          ? (only.properties as Record<string, unknown>)
          : {};
      const onlySignals = extractIdentitySignals(onlyProps);
      // `IdentitySignal.type` is a plain string upstream — index the
      // strong-signal key map through a widened view rather than casting the
      // signal type, so an unknown atom yields no keys instead of throwing.
      const signalKeyMap = IDENTITY_SIGNAL_PROPERTY_KEYS as Record<
        string,
        string[] | undefined
      >;
      const signalKeys = new Set(
        onlySignals.flatMap((s) => signalKeyMap[s.type] ?? [])
      );
      const carriesOnlyIdentity =
        !only.existingEntityId &&
        Object.keys(onlyProps).every((k) => signalKeys.has(k)) &&
        !hasDurableText(normalizeCaptureText(only.content)) &&
        !hasDurableText(normalizeCaptureText(only.description)) &&
        !(Array.isArray(only.facets) && only.facets.length > 0);
      if (onlySignals.length > 0 && carriesOnlyIdentity) {
        try {
          const known = await resolveIdentity(db, {
            userId,
            kindSlug: only.profileSlug as string,
            signals: onlySignals,
          });
          if (known.match === "strong" && known.entity) {
            // A BETTER TITLE is new information. The existing row may be
            // titled by its own signal ("ada@acme.com"); rejecting a call
            // that supplies "Ada Lovelace" would discard the improvement.
            const incomingTitle = normalizeCaptureText(only.title);
            const titleIsNew =
              hasDurableText(incomingTitle) &&
              incomingTitle !== normalizeCaptureText(known.entity.title ?? "");
            if (!titleIsNew) {
              // SECURITY: the STRONG path is deliberately pod-GLOBAL and
              // unscoped (frozen policy: one subject per email/phone), so
              // `known.entity` may belong to another user. Dedup still
              // applies pod-wide, but the matched row's CONTENT must not
              // leak — the same rule `buildIdentityResolveResponse` encodes.
              // Probe visibility here; when invisible, reject WITHOUT the
              // title/kind/id (no id ⇒ `ok()` emits no `/open/` link).
              const visible = await db.query.entities.findFirst({
                columns: { id: true },
                where: and(
                  eq(entities.id, known.entity.id),
                  isNull(entities.deletedAt),
                  // Owner-gate NULL-ws (mirrors the shared response builder)
                  // — a global strong signal must not leak a pod-wide
                  // owner-private dup's title/kind/id cross-tenant.
                  ownerPrivateVisibleWhere(
                    entities.workspaceId,
                    entities.userId,
                    userId
                  )
                ),
              });
              if (!visible) {
                return captureRejected({
                  reason: "already-known",
                  scope: graphScope,
                  message:
                    "An entity with this exact identity already exists in this pod and the call carried nothing new, so nothing was written. " +
                    "This is a correct outcome, not an error — do not retry it. To add information, send it here as content / extra properties / relations.",
                });
              }
              return captureRejected({
                reason: "already-known",
                scope: graphScope,
                message:
                  `A ${known.entity.type} with this exact identity already exists ("${known.entity.title ?? known.entity.id}") and the call carried nothing new, so nothing was written. ` +
                  "This is a correct outcome, not an error — do not retry it. To add information, either send it here as content / extra properties / relations (it will enrich the existing entity, not duplicate it) or call synap_update_entity on the id below.",
                extra: {
                  entityId: known.entity.id,
                  existing: {
                    id: known.entity.id,
                    title: known.entity.title,
                    profileSlug: known.entity.type,
                  },
                },
              });
            }
          }
        } catch (err) {
          // Best-effort: a lookup failure must never block a write.
          logger.warn({ err }, "capture: already-known pre-check failed");
        }
      }
    }

    // ── ADVISORY (never a reject): Wave-0 crossKindCandidates ────────────
    // Same title under a DIFFERENT kind — §2.3's `links.proposed` slot. A
    // link SUGGESTION for the agent/reviewer, never an auto-merge.
    const crossKindLinks: Array<{
      ref: string;
      candidateId: string;
      title: string | null;
      profileSlug: string;
      reason: string;
    }> = [];
    if (graphEntities.length <= CAPTURE_CROSSKIND_PRECHECK_MAX) {
      // Owner-gated READ floor (not bare userVisibleWhere) so weak
      // cross-kind fuzzy matches never surface another tenant's NULL-ws row.
      const visibleScope = accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
        facetLens: true,
      });
      for (const e of graphEntities) {
        if (e.existingEntityId) continue;
        const candidateTitle = normalizeCaptureText(e.title);
        if (!candidateTitle) continue;
        try {
          const res = await resolveIdentity(db, {
            userId,
            kindSlug: e.profileSlug as string,
            name: candidateTitle,
            signals: extractIdentitySignals(
              e.properties as Record<string, unknown> | undefined
            ),
            userScope: visibleScope,
          });
          for (const cand of res.crossKindCandidates) {
            crossKindLinks.push({
              ref: e.ref,
              candidateId: cand.id,
              title: cand.title,
              profileSlug: cand.type,
              reason: "same title across kinds",
            });
          }
        } catch (err) {
          logger.warn({ err }, "capture: cross-kind pre-check failed");
        }
      }
    }

    // Membership gate — the HTTP door does this via resolveActingContext.
    // Without it an MCP key could queue a proposal in a foreign lens. The
    // verdict was already computed once at the top of this function.
    if (graphWsId && !workspaceAccessible) {
      // ACTIONABLE, not a dead-end: adopt the same disambiguation shape
      // `rejectMissingWriteWorkspace`/`synap_set_workspace_focus` already
      // return — a bare "Forbidden" left the agent with nowhere to go.
      const available = await listMemberWorkspacesForAgent(userId);
      return ok({
        error: `Forbidden: no access to workspace ${graphWsId}`,
        availableWorkspaces: available,
      });
    }
    const { submitCaptureGraph } =
      await import("../../../services/capture-agent/submit-capture-graph.js");

    // AGENT-MODE routing (piece A): submitCaptureGraph derives the terminal
    // from identity + policy. We pass the acting `agentUserId` so the core
    // scores the graph against the ONE agent policy evaluator: when EVERY op
    // is auto-approvable it MATERIALIZES the graph now (a direct operator
    // write it builds itself, the same one the approve loop performs) and
    // records an `auto_approved` proposal; otherwise it files a pending one.
    const graphResult = await submitCaptureGraph({
      userId,
      ...(agentUserId ? { agentUserId } : {}),
      workspaceId: graphWsId,
      ...(captureProjectId ? { projectId: captureProjectId } : {}),
      ...(captureProjectName ? { projectName: captureProjectName } : {}),
      // Origin is the door, not a caller claim: an MCP caller is an agent.
      source: "agent",
      ...(sessionId ? { sessionId } : {}),
      // Shape-validated above (profileSlug present, refs unique and
      // resolvable) — the remaining fields are optional and pass straight
      // through to the same core the HTTP door feeds.
      entities: graphEntities as unknown as Parameters<
        typeof submitCaptureGraph
      >[0]["entities"],
      relations: captureRelations as unknown as Parameters<
        typeof submitCaptureGraph
      >[0]["relations"],
      ...(typeof args.summary === "string" && args.summary
        ? { summary: args.summary }
        : {}),
      // Provenance for a mixed text+entities payload (bounded by the core to
      // proposal data — reviewable, never silently discarded).
      ...(captureNormalizedText
        ? { rawSource: { rawText: captureRawText.slice(0, 8000) } }
        : {}),
    });
    // The terminal is policy-derived: `applied` (materialized now, whitelisted
    // graph) or `proposed` (pending review). `graphResult.writeReceipt`
    // already conforms to the uniform receipt (state applied|pending).
    return ok({
      status: graphResult.applied ? "applied" : "proposed",
      scope: graphScope,
      ...graphResult,
      ...(crossKindLinks.length ? { links: { proposed: crossKindLinks } } : {}),
      ...(captureNormalizedText
        ? {
            provenance:
              "Both `text` and `entities[]` were sent: the structured payload was used, and the raw text is kept on the proposal as provenance for the reviewer.",
          }
        : {}),
    });
  }

  // ══ TEXT BRANCH ═════════════════════════════════════════════════════════
  const { captureRouter } = await import("../../capture.js");
  // Placement already resolved into `requestedWorkspaceId`:
  //   1. explicit args.workspaceId / URL pin / service-key confinement
  //   2. advisory agent focus (pickAdvisoryWorkspaceId, above)
  // Domain text capture MUST NOT fall back to membership[0] (silent
  // wrong-placement — same bug link_entities stopped fabricating). Global
  // knowledge_keys may still need a concrete workspaceId column (below).
  let captureWsId: string | undefined = requestedWorkspaceId;
  const textScope: CaptureScope = {
    workspaceId: captureWsId ?? null,
    projectId: captureProjectId,
    sessionId: sessionId ?? null,
  };
  // ── REJECT: no-durable-content ─────────────────────────────────────────
  // Also the "empty payload" branch: neither `text` nor `entities[]`.
  if (!hasDurableText(captureNormalizedText)) {
    return captureRejected({
      reason: "no-durable-content",
      scope: textScope,
      message:
        "Nothing storable was sent. Pass `text` with something worth remembering (a fact, a decision, a person, a task, a document body), or pass `entities[]` when you already know the kind and its fields.",
    });
  }
  // GLOBAL lane — mirror the CLI's `capture --global`: a pod-wide procedural
  // runbook goes to knowledge_keys (a keyed doc upsert), NOT the entity
  // structuring pipeline. This folds the former synap_write_knowledge tool
  // into capture so there is ONE write door; the lane is the routing signal.
  if (args.global === true) {
    // POD-WIDE MEANS workspaceId NULL. Do not stamp a workspace here.
    //
    // This lane writes `knowledge_keys` — pod-wide runbook text, by definition
    // not domain placement. It used to fall back to `membership[0]` so the
    // upsert could complete, which quietly made every MCP-written runbook
    // workspace-scoped.
    //
    // That broke RECALL, because the two halves disagree: the reader
    // (`services/knowledge/ask.ts`, procedural lane) searches
    // `workspace_id = (workspaceId ?? userId) OR workspace_id IS NULL`, so a row
    // stamped with a real workspace matches ONLY if the caller happens to pass
    // that exact id. The CLI's `--global` writes NULL and is found; MCP's wrote
    // a workspace and was not. Verified live: a runbook captured through MCP
    // 404s on the default namespace and returns fine with
    // `?workspaceId=<the membership[0] workspace>` — and 19 such rows were
    // sitting unreachable on the dogfood pod.
    //
    // NULL is also what makes the lane's own promise true: a cross-cutting
    // runbook should be readable from every workspace, not one arbitrary one.
    const globalScope: CaptureScope = {
      ...textScope,
      workspaceId: null,
    };
    const text = args.text as string;
    const key =
      (args.key as string | undefined) ||
      `note:${text
        .slice(0, 48)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}`;
    const record = await knowledgeKeysRepository.upsert(key, {
      key,
      value: text,
      status: "active",
      // NULL = pod-wide. See the note above: a stamped workspace makes the row
      // unreachable from the default recall lens.
      workspaceId: null,
      author: userId,
    });
    const globalReceipt: CaptureWriteReceipt = {
      state: "applied",
      // Honest echo: this row is pod-wide, not placed in a workspace.
      effectiveWorkspaceId: null,
      ...(captureProjectId ? { projectId: captureProjectId } : {}),
      source: "agent",
    };
    return ok({
      status: "applied",
      lane: "global",
      scope: globalScope,
      writeReceipt: globalReceipt,
      knowledgeKey: record,
    });
  }
  // Domain text capture — workspace optional. Structure + execute place via
  // resolveWorkspacePlacement (kind/role ontology). Explicit/advisory lens
  // still flows as ambient; never invent membership[0].
  const captureCtx = await createHubProtocolCallerContext(
    userId,
    apiKeyScopes,
    captureWsId,
    undefined,
    sessionId,
    agentUserId
  );
  const captureCaller = captureRouter.createCaller(
    captureCtx as Parameters<typeof captureRouter.createCaller>[0]
  );
  // Step 1 — structure the free text into entity proposals.
  const structured = await captureCaller.structure({
    text: args.text as string,
    context: args.profileSlug
      ? `Hint: profile is ${args.profileSlug}`
      : undefined,
    dedupMode: args.dedupMode as "title" | "semantic" | "both" | undefined,
  });
  // Step 2 — ACTUALLY WRITE. structure() only previews; without execute()
  // the capture tool returns proposals that are never materialized — the
  // "write door" wrote nothing. Mirror the CLI's smart-capture (structure →
  // execute). First-party capture writes DIRECTLY and records an
  // auto-approved, revertible proposal — it does NOT return 'proposed' /
  // wait for review. The materialized entities come back in the result.
  const captureProposals =
    (structured as { proposals?: unknown[] }).proposals ?? [];
  // DEGRADED MODE: when the IS structurer is down, `structure()` returns the
  // shared labelled raw-note fallback (`buildDegradedCaptureFallback`,
  // routers/capture.ts:242, returned at :1144) with `degraded: true`. We
  // EXECUTE that fallback — the same note the tRPC/UI door already saves and
  // renders as "Saved as note (couldn't validate as X)". Refusing instead
  // created NOTHING, which loses the user's text entirely: the outage becomes
  // data loss. There is no second fallback here — `structured` IS the builder's
  // output; the normal execute path below writes it.
  //
  // BUT an MCP capture is UNATTENDED — no human watches the note appear — so
  // the label has to reach the AGENT, or a raw note quietly passes for a
  // structured one. That is what `degradedNotice` is for: it rides on BOTH
  // terminal returns below, and the wording tells the agent to say it out loud.
  // The WHY comes from the classified reason, never a stock "try again" that an
  // auth/credit failure would make false.
  const degradedCapture =
    (structured as { degraded?: boolean }).degraded === true;
  const degradedReason = (structured as { degradedReason?: string })
    .degradedReason;
  // `degradedReason` (capture.ts DegradedCaptureReason) is already a
  // classification — map it onto the shared failure classes rather than
  // re-deriving one.
  const degradedFailure = degradedCapture
    ? describeAiFailure(
        degradedReason === "is_auth_error"
          ? "auth"
          : degradedReason === "is_invalid_response" ||
              degradedReason === "is_empty_result"
            ? "invalid_response"
            : "unknown"
      )
    : null;
  const degradedNotice = degradedFailure
    ? `⚠️ AI structuring did not run. The text was saved as a RAW NOTE, unstructured and unclassified — ` +
      `it is NOT a person/task/decision/whatever it describes. ${degradedFailure.message} ` +
      `Tell the user their capture was saved as a plain note and was NOT structured` +
      (degradedFailure.retryable
        ? " — and that re-capturing shortly may structure it properly."
        : ", and do not tell them to try again.")
    : null;
  if (captureProposals.length === 0) {
    return captureRejected({
      reason: "no-durable-content",
      scope: textScope,
      message:
        "The text was read but nothing durable could be extracted from it. Say what the thing IS (a person, a task, a decision, a note) — or send `entities[]` directly when you already know the kind.",
      extra: {
        ...structured,
        executed: false,
        note: "Nothing to capture.",
      },
    });
  }
  // Dedup → merge: when structure found a high-confidence SAME-PROFILE
  // duplicate, point the proposal at the existing entity so execute MERGES
  // into it (via existingEntityId) instead of creating a near-duplicate.
  // The same-profileSlug guard is load-bearing — the dedup search is
  // cross-profile (semantic), so without it a `person` could merge into a
  // `note`. ≥0.95 auto-merges; anything lower is left to create (the
  // candidates are still surfaced to the caller in `structured`).
  const dedup =
    (
      structured as {
        dedupCandidates?: Record<
          string,
          Array<{ entityId: string; profileSlug: string; score: number }>
        >;
      }
    ).dedupCandidates ?? {};
  const mergedProposals = (
    captureProposals as Array<{
      tempId: string;
      profileSlug: string;
      existingEntityId?: string;
    }>
  ).map((p) => {
    const top = dedup[p.tempId]?.[0];
    if (
      top &&
      top.score >= 0.95 &&
      top.profileSlug === p.profileSlug &&
      !p.existingEntityId
    ) {
      return { ...p, existingEntityId: top.entityId };
    }
    return p;
  });
  // Workspace routing is centralized in captureCaller.execute (see
  // resolveCaptureRouting): the adapter just forwards the AI's structure
  // hints + the caller's mode, so MCP routes identically to every other door.
  const executed = await captureCaller.execute({
    // Idempotency keyed on the RAW TEXT, because this door is the only place
    // that still holds it. Everything below has already passed through the
    // structurer, whose output is LLM-generated and therefore not stable across
    // a re-run: a key derived from the structured proposals would fail to
    // collapse a genuine retry of the same capture, which is the one property
    // idempotency exists for. The raw text is the capture's real identity.
    //
    // Without this the router falls back to hashing the structured payload
    // (capture.ts) — a correct last resort for callers with no stable identity,
    // but strictly weaker than what this caller can supply.
    //
    // Known trade-off, accepted: two DELIBERATE captures of byte-identical text
    // by the same user collapse into one. That is also what the dedup pass would
    // have proposed, and it is far cheaper than the failure this replaces —
    // where a retry that re-structured differently created a second entity.
    // NORMALIZED, not raw: `normalizeCaptureText` only collapses whitespace runs
    // and trims, so it cannot merge two meaningfully different captures — but it
    // DOES survive a client that retries with different line wrapping or a
    // trailing newline, which the raw string would not. Retry-robustness is the
    // whole point, so the key takes the more stable of the two.
    // Day-bucketed, for the same reason the router's fallback is: the external
    // link lookup has no time predicate and the row is permanent, so an unbounded
    // key would make a recurring capture with a stable phrase ("Standup: no
    // blockers") link day 1's entity forever while reporting success. A retry
    // arrives within seconds; a UTC-day grain is ample.
    idempotencyKey: captureNormalizedText
      ? `cap-text:${new Date().toISOString().slice(0, 10)}:${createHash(
          "sha256"
        )
          .update(captureNormalizedText)
          .digest("hex")}`
      : undefined,
    entities: mergedProposals as Parameters<
      typeof captureCaller.execute
    >[0]["entities"],
    relations:
      ((structured as { relations?: unknown[] }).relations as Parameters<
        typeof captureCaller.execute
      >[0]["relations"]) ?? [],
    workspaceRouting: args.workspaceRouting as
      "auto" | "ask" | "locked" | undefined,
    // The ambient session, forwarded explicitly. `execute` reads `input.sessionId`
    // (capture.ts:1753) to run the `session --produced--> entity` link pass for
    // entities that were MERGED into an existing row — the create-side stamp only
    // fires on freshly created ones. Omitting it here meant an MCP capture that
    // deduped into an existing entity left no edge back to the session that
    // produced it, which is exactly the case a session dashboard needs most.
    ...(sessionId ? { sessionId } : {}),
    // Rung 1 of the placement ladder: a caller-pinned workspace (explicit
    // `args.workspaceId`, or a bound service key's confinement) must WIN over
    // ontology/session/relational routing, not just seed the ambient lens.
    // `confinedWorkspaceId` (unlike `requestedWorkspaceId`) never folds in the
    // agent's advisory focus, so an unpinned call still reaches
    // `resolveWorkspacePlacement`'s rungs 2-5 exactly as before. Mirrors the
    // hub REST door (routers/hub-protocol/rest/capture.ts), which already
    // keeps `targetWorkspaceId` separate from the ambient `workspaceId`.
    ...(confinedWorkspaceId ? { targetWorkspaceId: confinedWorkspaceId } : {}),
    aiWorkspaceId: (structured as { targetWorkspaceId?: string | null })
      .targetWorkspaceId,
    aiWorkspaceConfidence: (
      structured as { targetWorkspaceConfidence?: number | null }
    ).targetWorkspaceConfidence,
    aiWorkspaceReason: (structured as { targetWorkspaceReason?: string | null })
      .targetWorkspaceReason,
    // Explicit caller-provided projectId is a deliberate pin (rung 1) and
    // still auto-links. The AI's structure-RESOLVED target, however, must NOT
    // silently become an auto-link: `belongs_to_project` WIDENS cross-workspace
    // access, so the AI's guess rides the SAME propose/advisory lane as every
    // other surface — execute records it as a suggestion (chip), never links
    // it, unless a DETERMINISTIC rung (explicit / session / relational)
    // independently resolves the same project.
    ...(args.projectId ? { projectId: args.projectId as string } : {}),
    aiProjectId: (structured as { targetProjectId?: string | null })
      .targetProjectId,
    aiProjectConfidence: (
      structured as { targetProjectConfidence?: number | null }
    ).targetProjectConfidence,
    aiProjectReason: (structured as { targetProjectReason?: string | null })
      .targetProjectReason,
  });
  // execute() returns movedToWorkspace / pendingWorkspaceSwitch when routing
  // engaged — surface them at the top level for the caller.
  const ex = executed as {
    status?: string;
    movedToWorkspace?: string;
    pendingWorkspaceSwitch?: unknown;
    proposalId?: string;
    proposalType?: string;
    reviewUrl?: string;
    reviewPath?: string;
    summary?: string;
    reasoning?: string;
    message?: string;
    project?: {
      projectId?: string;
      rung: number | null;
      status: "linked" | "proposed" | "not_linked";
      reason?: string;
    };
  };

  // GOVERNANCE MAY HAVE ROUTED THIS TO REVIEW — say so.
  //
  // `captureCaller.execute()` returns `{status:"proposed", created:[], …}` with
  // NOTHING written when the workspace policy does not auto-approve
  // `entity.create` (routers/capture.ts, "Nothing was written"). This handler
  // used to fall through to a hardcoded `status:"applied"` receipt regardless,
  // so an agent was told the capture landed while a proposal sat unreviewed —
  // and because `ok()` only inspects the TOP-LEVEL status, the "proposed"
  // reinforcement and the review link never surfaced either.
  //
  // It stayed invisible because `entity.create` is in DEFAULT_AUTO_APPROVE, so
  // the branch only fires on a workspace that has deliberately tightened.
  //
  // Shape mirrors the entities[] lane above (top-level status + proposal
  // fields). No `writeReceipt`: that type is `applied | rejected` by
  // construction, and emitting an "applied" receipt for an unwritten capture is
  // the false-success bug the receipt exists to prevent.
  if (ex.status === "proposed") {
    return ok({
      status: "proposed",
      scope: {
        workspaceId: ex.movedToWorkspace ?? captureWsId ?? null,
        projectId: captureProjectId,
        sessionId: sessionId ?? null,
      },
      ...(ex.proposalId ? { proposalId: ex.proposalId } : {}),
      ...(ex.proposalType ? { proposalType: ex.proposalType } : {}),
      ...(ex.reviewUrl ? { reviewUrl: ex.reviewUrl } : {}),
      ...(ex.reviewPath ? { reviewPath: ex.reviewPath } : {}),
      ...(ex.summary ? { summary: ex.summary } : {}),
      ...(ex.reasoning ? { reasoning: ex.reasoning } : {}),
      ...(ex.message ? { message: ex.message } : {}),
      ...(degradedNotice
        ? {
            degraded: true,
            ...(degradedReason ? { degradedReason } : {}),
            degradedNotice,
          }
        : {}),
      structured,
      executed,
    });
  }
  // The scope echo must be what the write ACTUALLY landed in: routing may
  // have moved it (movedToWorkspace), and a project only counts when it was
  // LINKED — a `proposed` project is an unconfirmed suggestion, not placement.
  const landedWsId = ex.movedToWorkspace ?? captureWsId ?? null;
  const landedProjectId =
    ex.project?.status === "linked" ? ex.project.projectId : captureProjectId;
  const textReceipt: CaptureWriteReceipt = {
    state: "applied",
    effectiveWorkspaceId: landedWsId,
    ...(landedProjectId ? { projectId: landedProjectId } : {}),
    // Intent-vs-outcome on the project axis: a requested pin that did NOT
    // link (not_linked) is NAMED here, never dropped silently under an
    // otherwise-"applied" receipt.
    ...(ex.project ? { project: ex.project } : {}),
    source: "agent",
  };
  return ok({
    // Reached only when execute() actually materialized — the `proposed`
    // branch above returns early. (This comment used to claim capture is
    // ALWAYS direct and never proposed; that stopped being true when
    // `execute()` gained its governance gate.)
    status: "applied",
    scope: {
      workspaceId: landedWsId,
      projectId: landedProjectId,
      sessionId: sessionId ?? null,
    },
    writeReceipt: textReceipt,
    // The note LANDED, so the receipt is honestly "applied" — but what landed
    // is a raw note, not the structured thing the caller asked for. Say both.
    ...(degradedNotice
      ? {
          degraded: true,
          ...(degradedReason ? { degradedReason } : {}),
          degradedNotice,
        }
      : {}),
    structured,
    executed,
    ...(ex.movedToWorkspace ? { movedToWorkspace: ex.movedToWorkspace } : {}),
    ...(ex.pendingWorkspaceSwitch
      ? { pendingWorkspaceSwitch: ex.pendingWorkspaceSwitch }
      : {}),
    // State what happened on the project axis: linked-by-context (which rung)
    // vs proposed (AI suggestion awaiting confirmation) vs nothing (omitted).
    ...(ex.project
      ? {
          project: ex.project,
          projectDisposition:
            ex.project.status === "linked"
              ? `linked by context (rung ${ex.project.rung})`
              : ex.project.status === "not_linked"
                ? `not linked (${ex.project.reason ?? "unavailable"})`
                : "proposed (AI suggestion — confirm to file)",
        }
      : {}),
  });
};

export const captureHandlers: McpHandlerMap = {
  synap_capture: captureHandler,
  synap_capture_graph: captureHandler,
};
