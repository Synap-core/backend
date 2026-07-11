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
 * resolveIdentity) with `userVisibleWhere` scoping on the weak path — the same
 * predicate capture.execute builds, so a pre-check sees exactly what a real
 * capture would resolve against.
 */

import { z } from "@hono/zod-openapi";

import {
  db,
  entities,
  resolveIdentity,
  extractIdentitySignals,
  isLinkedinUrl,
  type IdentitySignal,
} from "@synap/database";

import { userVisibleWhere } from "../../../utils/user-visible-where.js";
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
  })
  .openapi("ResolveIdentityResponse");

/**
 * Map the request's explicit `signals` object to typed identity atoms. A bare
 * `url` is classified linkedin-vs-website by the same domain-anchored check the
 * extractor uses, so the pre-check and a real write agree on the atom type.
 */
function toSignals(
  signals:
    | {
        email?: string;
        phone?: string;
        url?: string;
        twitter?: string;
        github?: string;
        externalId?: string;
      }
    | undefined
): IdentitySignal[] {
  if (!signals) return [];
  const out: IdentitySignal[] = [];
  if (signals.email) out.push({ type: "email", value: signals.email });
  if (signals.phone) out.push({ type: "phone", value: signals.phone });
  if (signals.url) {
    out.push({
      type: isLinkedinUrl(signals.url) ? "linkedin_url" : "website",
      value: signals.url,
    });
  }
  if (signals.twitter)
    out.push({ type: "twitter_handle", value: signals.twitter });
  if (signals.github)
    out.push({ type: "github_username", value: signals.github });
  if (signals.externalId)
    out.push({ type: "external_id", value: signals.externalId });
  return out;
}

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
        ...toSignals(body.signals),
        ...extractIdentitySignals(body.properties),
      ];

      const resolution = await resolveIdentity(db, {
        userId,
        kindSlug: body.kindSlug,
        name: body.title,
        signals,
        userScope: userVisibleWhere(entities.workspaceId, userId),
        limit: 10,
      });

      return c.json({
        match: resolution.match ?? "none",
        entityId: resolution.entity?.id,
        entityTitle: resolution.entity?.title,
        entityKind: resolution.entity?.type,
        candidates: resolution.candidates.map((cand) => ({
          entityId: cand.id,
          title: cand.title,
          kind: cand.type,
        })),
      });
    } catch (err) {
      logger.error({ err, userId }, "POST /identity/resolve failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
