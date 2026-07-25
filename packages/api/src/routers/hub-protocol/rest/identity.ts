/**
 * Hub Protocol REST — /identity/resolve
 *
 * Read-only identity PRE-CHECK. An agent calls this BEFORE creating an entity
 * to decide create-vs-enrich-vs-attach_facet: a STRONG signal match (email /
 * phone / url / handle / external-id) means the subject already exists — link
 * or attach a facet instead of spinning up a duplicate; a WEAK (same-name)
 * match returns advisory candidates; no match means create is safe.
 *
 * Thin wrapper over the ONE identity matcher (IdentityResolutionService.
 * resolveIdentity) with `accessScopeWhere` scoping on the weak path — the entity
 * READ floor (owner-gated NULL + membership + exposure + role-lens), the same
 * predicate `entities.list` / `resolveEntityByName` build, so a pre-check sees
 * exactly what a real capture would resolve against and can't leak a NULL-ws
 * entity by name.
 */

import { z } from "@hono/zod-openapi";

import {
  db,
  entities,
  resolveIdentity,
  extractIdentitySignals,
  signalsFromExplicit,
  type IdentitySignal,
} from "@synap/database";

import { accessScopeWhere } from "../../../utils/project-scope.js";
import { buildIdentityResolveResponse } from "../../../utils/identity-resolve-response.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const ResolveIdentityRequestSchema = z
  .object({
    kindSlug: z
      .string()
      .optional()
      .describe(
        "The entity kind (profile slug) being created. A weak (same-name) match must be this kind to become `match:'weak'`; cross-kind rows still ride in `candidates`."
      ),
    title: z
      .string()
      .optional()
      .describe("Name/title to weak-match. Blank → strong-signal lookup only."),
    workspaceId: z.string().uuid().optional(),
    signals: z
      .object({
        email: z.string().optional(),
        phone: z.string().optional(),
        url: z.string().optional(),
        twitter: z.string().optional(),
        github: z.string().optional(),
        externalId: z
          .string()
          .optional()
          .describe("Provider-qualified id, e.g. `github:12345`."),
      })
      .optional()
      .describe("Explicit strong identity atoms."),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Draft property bag — strong signals are also extracted from it (merged with `signals`)."
      ),
  })
  .openapi("ResolveIdentityRequest");

const ResolveIdentityResponseSchema = z
  .object({
    match: z.enum(["strong", "weak", "none"]),
    entityId: z.string().optional(),
    entityTitle: z.string().nullable().optional(),
    entityKind: z.string().optional(),
    candidates: z.array(
      z.object({
        entityId: z.string(),
        title: z.string().nullable(),
        kind: z.string(),
        score: z.number().optional(),
      })
    ),
    crossKindCandidates: z
      .array(
        z.object({
          entityId: z.string(),
          title: z.string().nullable(),
          kind: z.string(),
        })
      )
      .describe(
        'Same-title entities of a DIFFERENT kind. ADVISORY: `match` stays "none" because a title alone never auto-merges — but do NOT treat "none" as "safe to create" when this is non-empty. Prefer proposing a link to one of these over minting a duplicate.'
      ),
    pendingCandidates: z
      .array(
        z.object({
          proposalId: z.string(),
          proposalType: z.string(),
          summary: z.string().optional(),
          entityRef: z.string().optional(),
          entityTitle: z.string().optional(),
          profileSlug: z.string().optional(),
          matchedSignals: z.array(
            z.object({ type: z.string(), value: z.string() })
          ),
        })
      )
      .optional()
      .describe(
        'Strong-signal matches in YOUR OWN pending capture proposals — a duplicate already in-flight but not yet committed (so `match` is still "none"). ADVISORY: carries a proposalId, NEVER an entityId — do NOT link to it (it can still be rejected). Wait for review or revise, rather than filing a second copy.'
      ),
  })
  .openapi("ResolveIdentityResponse");

// Explicit-signals → typed atoms mapping lives in the identity service
// (`signalsFromExplicit`) — the ONE mapper shared with synap_resolve_identity.

export function registerIdentityRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/identity/resolve",
    tags: ["Entities"],
    summary: "Resolve identity (read-only) — does this subject already exist?",
    description:
      "Call BEFORE create to decide create-vs-enrich-vs-attach_facet. Returns " +
      "`match:'strong'` (globally-unique signal hit — link/attach, don't create), " +
      "`'weak'` (same-name candidates — advisory), or `'none'`. Read-only; never writes.",
    request: { body: ResolveIdentityRequestSchema },
    responses: {
      200: {
        description: "Identity resolution result",
        schema: ResolveIdentityResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/identity/resolve", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.read") &&
      !hasScope(c.get("scopes") as string[], "mcp.read")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.read or mcp.read" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ResolveIdentityRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // Merge explicit atoms with any extracted from the draft property bag —
      // the richest lookup. Identity is global (a subject exists once pod-wide),
      // so scope the weak path to the user's visible rows, not one workspace.
      const signals: IdentitySignal[] = [
        ...signalsFromExplicit(body.signals),
        ...extractIdentitySignals(body.properties),
      ];

      const resolution = await resolveIdentity(db, {
        userId,
        kindSlug: body.kindSlug,
        name: body.title,
        signals,
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
      // one door for both this route and the MCP synap_resolve_identity tool).
      // Pass `signals` so it also surfaces pending in-flight duplicates.
      return c.json(
        await buildIdentityResolveResponse(resolution, userId, signals)
      );
    } catch (err) {
      logger.error({ err, userId }, "POST /identity/resolve failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
