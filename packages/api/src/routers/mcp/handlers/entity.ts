/**
 * MCP tool handlers — entity domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { entitiesRouter as regularEntitiesRouter } from "../../entities.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { checkHubRateLimit } from "../../../utils/hub-protocol-rate-limit.js";
import { isAllowedMimeType, MAX_FILE_SIZE } from "../../file-upload.js";
import {
  db,
  entities,
  resolveIdentity,
  extractIdentitySignals,
  signalsFromExplicit,
  type IdentitySignal,
} from "@synap/database";
import { type UserObservationCategory } from "../../../services/knowledge/remember-fact.js";
import { accessScopeWhere } from "../../../utils/project-scope.js";
import { buildIdentityResolveResponse } from "../../../utils/identity-resolve-response.js";
import {
  ok,
  requireScope,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";
import { toolError } from "../tool-errors.js";

export const entityHandlers: McpHandlerMap = {
  synap_create_entity: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      lensCaller,
      lensWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // `lensCaller` carries the injected `?workspaceId=` lens as the AMBIENT
    // governance workspace (see above) — without it the hub picked a random
    // membership and the caller got a `workspace.join` proposal instead of an
    // entity proposal. It is deliberately NOT passed as the input's explicit
    // `workspaceId` (that is a rung-1 placement pin and would workspace-pin
    // pod-scope kinds — the four-door bug).
    const profileSlug =
      (args.profileSlug as string | undefined) ||
      (args.type as string | undefined);
    const result = await lensCaller.entities.createEntity({
      userId,
      profileSlug,
      title: args.title as string,
      description: args.description as string | undefined,
      // Long-form body → a versioned linked document (via EntityBodyService,
      // inside the entities `create` door this calls).
      // The hub input has always accepted `content`; the MCP schema could not
      // SEND it, so an agent had to make a second create_document call and
      // wire it up by hand. Forwarded here = long-text → document in ONE call.
      ...(typeof args.content === "string" && args.content
        ? { content: args.content }
        : {}),
      properties: args.properties as Record<string, unknown> | undefined,
      // A project-pinned MCP URL (?projectId=) auto-injects args.projectId, so
      // entities the agent creates are filed into its project focus.
      ...(args.projectId ? { projectId: args.projectId as string } : {}),
      // Kind + Facets: attach role-profiles in the same create call (governed
      // via entities.attachFacet on the created entity).
      ...(Array.isArray(args.facets)
        ? {
            facets: args.facets as Array<{
              slug: string;
              properties?: Record<string, unknown>;
            }>,
          }
        : {}),
      // Bypass weak same-name gate only (strong merge never bypassed).
      ...(args.forceCreate === true ? { forceCreate: true } : {}),
      // agent-key remap: the write is OWNED by the operator (userId) but
      // AUTHORED by the agent — pass agentUserId so governance proposes.
      ...(agentUserId ? { agentUserId } : {}),
      aiMetadata: { model: "mcp", reasoning: `MCP tool: ${toolName}` },
    });

    // ── The write receipt (the thing MCP callers never got) ────────────────
    // REST callers have long received `writeReceipt` (truthful pending /
    // applied / partial + per-facet outcomes + warnings) and `resolution`
    // (what already exists under this name). MCP calls the tRPC procedure
    // directly, so it returned a bare id. Same shared builder, same blocks —
    // one receipt shape for every transport.
    //
    // NOT wrapped in try/catch on purpose: buildCreateEntityReceipt never
    // throws (resolution failures come back as `resolution: undefined`), and a
    // catch here would swallow the receipt it is meant to deliver.
    //
    // It also has an INTENDED side effect: same-name/different-profile matches
    // are auto-connected with a governed `same_subject` relation.
    const { buildCreateEntityReceipt } =
      await import("../../hub-protocol/write-receipt.js");
    const created = result as Record<string, unknown>;
    // The hub procedure echoes the AMBIENT governance lens it resolved (which
    // may be the membership fallback, not our injected lens) — prefer it, and
    // fall back to the URL lens. Not the entity's placement: a pod-scope kind
    // still lands pod-wide. Same caveat as the hub's own echo.
    const receiptWorkspaceId =
      (typeof created.workspaceId === "string" ? created.workspaceId : null) ??
      lensWorkspaceId ??
      null;
    const { writeReceipt, resolution } = await buildCreateEntityReceipt({
      result: created,
      profileSlug: profileSlug ?? "",
      effectiveWorkspaceId: receiptWorkspaceId,
      userId,
      scopes: apiKeyScopes,
      title: args.title as string,
      ...(args.projectId ? { projectId: args.projectId as string } : {}),
      source: "agent",
      ...(agentUserId ? { resolvedAgentUserId: agentUserId } : {}),
    });
    return ok({
      ...created,
      effectiveWorkspaceId: receiptWorkspaceId,
      writeReceipt,
      ...(resolution ? { resolution } : {}),
    });
  },
  synap_update_entity: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      lensCaller,
      caller,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const entityId = args.entityId as string;
    // BODY (long-form `content`) does NOT live on the entity row — it lives on
    // the LINKED DOCUMENT (`entities.documentId`; `documents.entityId` was
    // removed). `synap_capture`/`synap_create_entity` already accept `content`
    // and materialize it as that document, so before this the body was
    // WRITE-ONCE: creatable, readable (`synap_get_document`), never updatable.
    // Routing it here rather than adding a 23rd tool keeps ONE door for
    // "change this entity" and matches where an agent already holds an
    // entityId (it captured the entity; it never saw a documentId).
    const content = args.content as string | undefined;
    const hasEntityFields =
      args.title !== undefined ||
      args.description !== undefined ||
      args.properties !== undefined ||
      args.metadata !== undefined;

    let body: Record<string, unknown> | undefined;
    if (content !== undefined) {
      // 1. Resolve the linked document UNDER THE ACCESS FLOOR. `entities.get`
      //    is `podProcedure` + `entityReadVisibleWhere(ctx.userId)` — the same
      //    owner/visibility predicate `synap_get_entity` reads through. Never
      //    a bare `db.query.entities` lookup on a model-supplied id.
      const entityCallerCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        undefined,
        undefined,
        undefined,
        agentUserId
      );
      const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
      const { entity } = await entityCaller.get({ id: entityId });
      const documentId = (entity as { documentId?: string | null } | null)
        ?.documentId;

      // 2. No body document yet ⇒ REFUSE, naming the door that creates AND
      //    attaches one in a single governed call. Creating it here would be a
      //    second create+attach path beside `synap_create_document`, and a
      //    silent no-op would hide the miss entirely.
      if (!documentId) {
        return toolError(
          `Entity ${entityId} has no body document, so there is nothing to update. ` +
            `Create and attach one in a single call: synap_create_document({ entityId: "${entityId}", title, content }).`
        );
      }

      // 3. Governed edit through the EXISTING door — `createDocumentProposal`
      //    (hub-protocol/documents.ts), the same procedure Hub REST
      //    `PATCH /api/hub/documents/:id` uses. It re-checks `doc.userId`
      //    (FORBIDDEN on mismatch) and always files a proposal; the approval
      //    half is the `targetType === "document"` branch (B3) in
      //    `proposals/apply-approval.ts`, which uploads the new content and
      //    snapshots a `document_versions` row.
      const current = await caller.documents.getDocument({
        documentId,
        userId,
      });
      const originalContent = current.document.content ?? "";
      const proposal = await caller.documents.createDocumentProposal({
        documentId,
        userId,
        ...(agentUserId ? { agentUserId } : {}),
        proposalType: "ai_edit",
        changes: [
          { op: "replace", range: [0, originalContent.length], text: content },
        ],
        originalContent,
        proposedContent: content,
      });
      body = { documentId, ...(proposal as Record<string, unknown>) };
    }

    // A content-only call must NOT also file an all-undefined entity proposal.
    if (!hasEntityFields && body) return ok({ entityId, body });

    // Same omission as create: hub `updateEntity` derives its governance lens
    // from `ctx.workspaceId`, which was always null for MCP callers.
    const result = await lensCaller.entities.updateEntity({
      entityId,
      userId,
      title: args.title as string | undefined,
      preview: args.description as string | undefined,
      // properties merges into the JSONB column; metadata is a legacy alias
      metadata: (args.properties ?? args.metadata) as
        Record<string, unknown> | undefined,
      ...(agentUserId ? { agentUserId } : {}),
    });
    // Two governed writes, two independent outcomes — the entity fields may
    // auto-approve while the body edit is still `proposed`. Report both rather
    // than collapsing them into one status the caller would misread.
    return ok(body ? { ...(result as Record<string, unknown>), body } : result);
  },
  synap_create_document: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      caller,
      requestedWorkspaceId,
      lensWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const result = await caller.documents.createDocument({
      userId,
      // Idempotency: a retry with the same key/content returns the prior doc.
      idempotencyKey: args.idempotencyKey as string | undefined,
      // Confined workspace (service-key clamp) — not the raw model-supplied id.
      workspaceId: requestedWorkspaceId as string,
      title: args.title as string,
      content: (args.content as string) || "",
      // External reference: a URL to a file/page the agent has (but no bytes
      // to upload). Creates a reference document (storageKey NULL) — the
      // agent-appropriate "here's a file" path when there's no local binary.
      ...(args.url ? { url: args.url as string } : {}),
      reasoning: "Created via MCP",
      ...(agentUserId ? { agentUserId } : {}),
    });
    // ATTACHMENT (the description used to claim it without doing it). The
    // link lives on `entities.documentId` — `documents.entityId` was removed —
    // so it is a separate GOVERNED entity update through the regular entities
    // router, not a side effect of the document write.
    const attachEntityId = args.entityId as string | undefined;
    if (!attachEntityId) return ok(result);
    const doc = result as Record<string, unknown>;
    // A proposal-gated document has no row yet: `documentId` is only the id it
    // WILL get. Linking to it now would leave a dangling reference, so say so
    // instead of pretending the attach happened.
    if (doc.status === "proposed") {
      return ok({
        ...doc,
        attached: {
          entityId: attachEntityId,
          status: "skipped",
          reason:
            "The document itself is awaiting review — approve it first, then attach it with synap_update_entity.",
        },
      });
    }
    const documentId =
      typeof doc.documentId === "string"
        ? doc.documentId
        : typeof doc.id === "string"
          ? doc.id
          : undefined;
    if (!documentId) return ok(result);
    const attachCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      // Membership-gated lens, never the raw model-supplied id — this ctx
      // drives a GOVERNED entity update (see the SECURITY note on lensCaller).
      lensWorkspaceId,
      undefined,
      sessionId,
      agentUserId
    );
    const attachCaller = regularEntitiesRouter.createCaller(attachCtx);
    const attached = await attachCaller.update({
      id: attachEntityId,
      documentId,
      reasoning: `Attach document created via MCP tool: ${toolName}`,
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok({
      ...doc,
      attached: {
        entityId: attachEntityId,
        documentId,
        // Governed like every other entity update: an agent may get a
        // proposal here even though the document itself was auto-approved.
        ...(attached as Record<string, unknown>),
      },
    });
  },
  synap_store_file: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      keyType,
      keyWorkspaceId,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Bound the unreviewed-upload vector, same limiter bucket as POST /files.
    // MCP hardcodes apiKeyId ("mcp") in the ctx, so key the limit on the acting
    // caller identity (agent, else operator) for per-caller isolation.
    try {
      checkHubRateLimit(agentUserId ?? userId, "files");
    } catch {
      throw new Error(
        "Rate limit exceeded for file storage (30/min). Retry shortly."
      );
    }

    const filename =
      typeof args.filename === "string" ? args.filename.trim() : "";
    const mimeType =
      typeof args.mimeType === "string" ? args.mimeType.trim() : "";
    if (!filename) throw new Error("filename is required.");
    if (!mimeType) throw new Error("mimeType is required.");

    // Exactly ONE of content (UTF-8 text) | contentBase64 (binary).
    const hasText = typeof args.content === "string";
    const hasBase64 = typeof args.contentBase64 === "string";
    if (hasText === hasBase64) {
      throw new Error(
        "Provide exactly one of `content` (UTF-8 text) or `contentBase64` (binary)."
      );
    }
    const buffer = hasText
      ? Buffer.from(args.content as string, "utf-8")
      : Buffer.from(args.contentBase64 as string, "base64");

    // SAME guards as the POST /files door: non-empty, allowed mime, size cap.
    if (buffer.length === 0) throw new Error("Decoded file is empty.");
    if (!isAllowedMimeType(mimeType)) {
      throw new Error(`MIME type not allowed: ${mimeType}`);
    }
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB via this inline path. ` +
          "For a large file on disk, use the CLI `synap upload`."
      );
    }

    // Use the CONFINED workspace (service-key clamp), never a raw model id.
    // A store needs a concrete workspace for the storage path + membership.
    if (!requestedWorkspaceId) {
      throw new Error(
        "workspaceId is required (none was supplied or accessible to your key)."
      );
    }
    const storeWorkspaceId = requestedWorkspaceId;

    const title =
      typeof args.title === "string" && args.title.trim()
        ? args.title.trim()
        : undefined;
    const attachToEntityId =
      typeof args.attachToEntityId === "string" && args.attachToEntityId.trim()
        ? args.attachToEntityId.trim()
        : undefined;

    // ── Attach mode: stored blob → provenance on an existing entity ────────
    // SAME internal door as POST /entities/:id/source-file. A stored blob,
    // NEVER analyzed — no capture/intelligence path is touched.
    if (attachToEntityId) {
      const { storeEntitySourceBlob } =
        await import("../../../utils/store-entity-source-blob.js");
      const attached = await storeEntitySourceBlob({
        database: db,
        userId,
        entityId: attachToEntityId,
        buffer,
        mimeType,
        filename,
        workspaceId: storeWorkspaceId,
      });
      return ok({
        entityId: attachToEntityId,
        documentId: attached.documentId,
        status: "attached",
      });
    }

    // ── New `file` entity via the GOVERNED, non-HTTP entry point ───────────
    // Deterministic store → governed `entities.create` (propose or auto-apply).
    // `agentUserId` is threaded for honest provenance. No LLM is ever called.
    const { createGovernedFileEntityFromBuffer } =
      await import("../../create-governed-file-entity.js");
    const stored = await createGovernedFileEntityFromBuffer({
      buffer,
      mimeType,
      filename,
      title,
      userId,
      workspaceId: storeWorkspaceId,
      agentUserId,
      scopes: apiKeyScopes,
      sessionId,
      keyType,
      keyWorkspaceId,
    });
    if (stored.status === "proposed") {
      return ok({
        proposalId: stored.proposalId,
        documentId: stored.documentId,
        status: "proposed",
        reviewUrl: stored.reviewUrl,
      });
    }
    return ok({
      fileEntityId: stored.fileEntityId,
      documentId: stored.documentId,
      status: "created",
    });
  },
  synap_remember_fact: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, lensCaller } =
      ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // GOVERNED: a fact about the user is a `user_observation` entity now, not
    // an ungoverned `knowledge_facts` row. AI-INFERRED → proposed;
    // `userStated: true` → auto-approved (the policy rung reads
    // `uo_validated`). `lensCaller` carries the workspace lens + agent
    // identity + session handle, exactly like create_entity.
    const { rememberFact, USER_OBSERVATION_CATEGORIES } =
      await import("../../../services/knowledge/remember-fact.js");
    // Off-enum categories were written unchecked. Validate against the SSOT
    // and fall back to the service's own default rather than failing the write.
    const factCategory =
      typeof args.category === "string" &&
      (USER_OBSERVATION_CATEGORIES as readonly string[]).includes(args.category)
        ? (args.category as UserObservationCategory)
        : undefined;
    const result = await rememberFact({
      // Idempotency: a repeated fact within the door's window returns the
      // prior factId instead of a second governed write + recall row.
      idempotencyKey: args.idempotencyKey as string | undefined,
      caller: lensCaller,
      // NEVER `args.userId`: the hub `createEntity` trusts `input.userId`, so a
      // model-supplied one would mint an entity + proposal owned by another
      // user. The API key already identifies the caller.
      userId,
      fact: args.fact as string,
      ...(typeof args.confidence === "number"
        ? { confidence: args.confidence }
        : {}),
      ...(factCategory ? { category: factCategory } : {}),
      ...(args.userStated === true ? { userStated: true } : {}),
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_link_entities: async (ctx: McpToolContext): Promise<CallToolResult> => {
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
    // Placement + governance workspace are DERIVED from the two endpoints (rung
    // 4 — relational gravity) inside relations.create. We no longer fabricate an
    // arbitrary `getUserMemberWorkspaceIds()[0]` (the latent wrong-placement bug —
    // that filed the edge into a random workspace the user happened to be first
    // in). The confined lens (requestedWorkspaceId — the service-key clamp) is
    // passed ONLY when present so a bound key stays pinned; absent → the door
    // derives from the endpoints' shared lens.
    const result = await caller.relations.createRelation({
      userId,
      ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
      sourceEntityId: args.sourceEntityId as string,
      targetEntityId: args.targetEntityId as string,
      // `relates_to` — NOT `related`. The default must name a relation def that
      // actually exists: `relations.createRelation` requires a `relation_defs`
      // row for the slug, and `related` is not one of the 22 pod-wide defaults
      // (`database/src/utils/default-relation-defs.ts`) — so every type-omitting
      // link call used to 400, silently blocking agent-authored graph edges.
      type: (args.type as string) || "relates_to",
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_attach_facet: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      lensCaller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // lensCaller: the hub facet procs derive their governance workspace from
    // ctx.workspaceId, which was always null for MCP callers (same omission
    // as create/update — the explicit `workspaceId` below is the FACET lens,
    // not the governance one).
    const result = await lensCaller.entities.attachFacet({
      userId,
      entityId: args.entityId as string,
      profileSlug: args.facetSlug as string,
      ...(args.properties
        ? { properties: args.properties as Record<string, unknown> }
        : {}),
      // Confined facet lens (service-key clamp) — a bound key can only scope
      // the facet to its own workspace.
      ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
      ...(args.contextEntityId
        ? { contextEntityId: args.contextEntityId as string }
        : {}),
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_detach_facet: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, lensCaller } =
      ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // The one-door detach is keyed by facetId. Accept a facetId directly (the
    // handle attach returns), or resolve entityId + facetSlug → facetId via the
    // entity's live facets (the ergonomic form an agent knows), then detach
    // through the SAME governed door — a lookup before the door, not a bypass.
    let facetId = args.facetId as string | undefined;
    if (!facetId) {
      const entityId = args.entityId as string | undefined;
      const facetSlug = args.facetSlug as string | undefined;
      if (!entityId || !facetSlug) {
        return ok({
          error: "Provide facetId, or entityId + facetSlug, to detach a facet",
        });
      }
      const entityCallerCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        (args.workspaceId as string) || undefined,
        undefined,
        undefined,
        agentUserId
      );
      const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
      const entityResult = await entityCaller.get({
        id: entityId,
        includeProfile: true,
        ...(args.workspaceId
          ? { workspaceId: args.workspaceId as string }
          : {}),
      });
      const facets =
        (
          entityResult as {
            facets?: Array<{
              facet: { id: string; workspaceId: string | null };
              profile: { slug?: string };
            }>;
          }
        ).facets ?? [];
      const matches = facets.filter((f) => f.profile?.slug === facetSlug);
      if (matches.length === 0) {
        return ok({
          error: `No live '${facetSlug}' facet on entity ${entityId}`,
        });
      }
      if (matches.length > 1) {
        // Same role attached in more than one workspace lens — picking the
        // first would detach a nondeterministic one, and the proposal card
        // keys on the opaque facetId so a reviewer wouldn't catch it. Make
        // the caller choose: pass workspaceId to narrow the lens, or the
        // exact facetId.
        return ok({
          error: `Entity ${entityId} carries ${matches.length} live '${facetSlug}' facets — pass workspaceId or an explicit facetId`,
          candidates: matches.map((f) => ({
            facetId: f.facet.id,
            workspaceId: f.facet.workspaceId,
          })),
        });
      }
      facetId = matches[0].facet.id;
    }
    // lensCaller: same governance-lens omission as attachFacet above.
    const result = await lensCaller.entities.detachFacet({
      userId,
      facetId,
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_resolve_identity: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // Read-only identity pre-check via the ONE matcher. Same call the REST
    // /identity/resolve route makes — resolved here directly (no HTTP hop),
    // mirroring how synap_get_entity uses the entities router in-process.
    // Explicit atoms via the ONE shared mapper (same as the REST route), plus
    // any mined from the draft property bag (richest lookup).
    const signals: IdentitySignal[] = [
      ...signalsFromExplicit(
        args.signals as Parameters<typeof signalsFromExplicit>[0]
      ),
      ...extractIdentitySignals(
        args.properties as Record<string, unknown> | undefined
      ),
    ];

    const resolution = await resolveIdentity(db, {
      userId,
      kindSlug: args.kindSlug as string | undefined,
      name: args.title as string | undefined,
      signals,
      // Identity is global (a subject exists once pod-wide) → scope the weak
      // path to the caller's READ floor (owner-gated NULL + facet-lens), never
      // bare userVisibleWhere (which admits pod-wide NULL-ws entities to all →
      // weak candidates would leak another tenant's private entity title).
      userScope: accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
        facetLens: true,
      }),
      limit: 10,
    });

    // Cross-user content scoping lives in the shared response builder (the
    // one door for both this tool and the Hub REST /identity/resolve route).
    // Pass `signals` so it also surfaces pending in-flight duplicates —
    // resolve_identity is the pre-create check, exactly where a caller must
    // learn "you already have this in your pending queue" before minting one.
    return ok(await buildIdentityResolveResponse(resolution, userId, signals));
  },
};
