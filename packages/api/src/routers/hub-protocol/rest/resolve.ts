/**
 * Hub Protocol REST — /resolve
 *
 * Universal ID resolver. Takes any UUID and returns what type of thing it is.
 *
 * AI agents call this when they want to open something but don't know the type.
 * Usage: synap open <id> → CLI calls this endpoint → dispatches the right deep link.
 *
 * ── THIS ENDPOINT OWNS NO PROBE LIST ─────────────────────────────────────────
 * It used to: four hand-written kinds (proposal, entity, view, document) with
 * their own inline queries, next to `services/diagnose/resolve-object-kind.ts`'s
 * SEVEN in the same package — a second answer to "which table holds this id?".
 * The user-visible cost was that `synap open <bare-id>` reached 4 of the ~21
 * kinds the browser routes: every capability-substrate object (skill, session,
 * playbook run, agent, …) came back `unknown` → "Nothing to open."
 *
 * The MECHANISM is now `resolveObjectKind` (which absorbed this file's `view`
 * and `document` probes, floors verbatim — they existed only here). The LABEL
 * is a per-consumer projection: `resolve-browser-route.ts` maps a probed kind
 * onto `object-nav.ts`'s route table, because this endpoint's only consumer is
 * the CLI and a label the browser has no arm for is a dead link.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { resolveByName } from "../../../services/object-graph/graph-service.js";
import { resolveObjectKind } from "../../../services/diagnose/resolve-object-kind.js";
import { browserRouteFor, EMITTABLE_LABELS } from "./resolve-browser-route.js";

const ResolveByNameSchema = z
  .object({
    matches: z.array(
      z.object({
        kind: z.string(),
        id: z.string(),
        name: z.string(),
        subtype: z.string().nullable(),
        workspaceId: z.string().nullable(),
      })
    ),
    /** True when exactly one object matched — safe to act on directly. */
    unique: z.boolean(),
  })
  .openapi("ResolveByNameResponse");

/** `unknown` is not a routable label — it is the honest "no match" answer. */
const UNKNOWN_TYPE = "unknown";

const ResolveResponseSchema = z
  .object({
    type: z
      .string()
      .describe(
        "Browser-routable label for the given ID — an `object-nav.ts` case " +
          `label, one of: ${[...EMITTABLE_LABELS, UNKNOWN_TYPE].join(", ")}. ` +
          "Never a free string: see resolve-browser-route.ts."
      ),
    /**
     * The id to OPEN — not always the id queried. A correlationId handed back
     * by a capability run resolves to the proposal (or skill) row it belongs
     * to, and that ROW id is what a deep link must carry.
     */
    id: z.string().describe("The id to open (may differ from the queried id)"),
    displayName: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    profileSlug: z.string().nullable().optional(),
    /**
     * False when the id resolved but the thing has no browser surface at all
     * (an external send). The caller must report what it is rather than mint a
     * deep link that lands nowhere — a dead link is worse than a refusal.
     */
    openable: z
      .boolean()
      .describe("Whether `type` names a surface the browser can open"),
    /**
     * Address parameters the deep link must carry for `type` to be resolvable.
     * Only runs use one today (`flowType`), because a run is addressed by
     * `{flowType, runId}` and the id alone does not identify it.
     */
    params: z.record(z.string(), z.string()).optional(),
  })
  .openapi("ResolveResponse");

export function registerResolveRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/resolve/{id}",
    tags: ["System"],
    summary: "Universal ID resolver — what type is this ID?",
    description:
      "Given any UUID, returns what type of thing it is (proposal, entity, view, document, or unknown). " +
      "AI agents use this before opening something in the browser — they don't need to know the type upfront.",
    responses: {
      200: {
        description: "Resolved type information",
        schema: ResolveResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Name-addressing: GET /resolve?kind=&name=&subtype= ───────────────────
  // The dual of /resolve/:id — find an object by its NAME (a handle) instead of
  // its uuid. Names aren't unique pod-wide, so it returns ALL matches + a
  // `unique` flag. Registered BEFORE /resolve/:id (Hono static-before-dynamic).
  registerOpenApi(app, {
    method: "get",
    path: "/resolve",
    tags: ["System"],
    summary: "Resolve an object by NAME (not id)",
    description:
      "Find objects of a given kind by name — the navigable-by-name half of the graph. " +
      "Returns every match (names aren't unique) + `unique`. Pass `subtype` to narrow " +
      "(entity profileSlug, view type, tool/skill kind).",
    request: {
      query: z.object({
        kind: z.string(),
        name: z.string(),
        subtype: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Matches", schema: ResolveByNameSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/resolve", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const kind = c.req.query("kind");
    const name = c.req.query("name");
    const subtype = c.req.query("subtype") || undefined;
    if (!kind || !name) {
      return c.json({ error: "kind and name are required" }, 400);
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const matches = await resolveByName(acting.userId, kind, name, subtype);
    return c.json({ matches, unique: matches.length === 1 }, 200);
  });

  app.get("/resolve/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }

    // Bind the resolve to the acting principal. Every probe inside
    // `resolveObjectKind` ANDs the acting user's visibility floor onto its
    // `eq(table.id, id)` lookup — without it, resolve returned title +
    // workspaceId for ANY row in the pod (a cross-tenant existence + metadata
    // leak). Not-found (→ `unknown`) is the correct response for an id the
    // caller cannot see. The floors are UNCHANGED by the consolidation: the
    // `view` and `document` predicates moved into the prober verbatim.
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    let resolved;
    try {
      resolved = await resolveObjectKind(id, acting.userId);
    } catch (err) {
      // Same posture as the old per-probe try/catch: a resolver failure is not
      // an outage for the caller, it is "I could not tell you what this is".
      logger.warn({ err, id }, "resolve failed (returning unknown)");
      resolved = null;
    }

    if (!resolved) {
      return c.json({
        type: UNKNOWN_TYPE,
        id,
        displayName: null,
        workspaceId: null,
        openable: false,
      });
    }

    const route = browserRouteFor(resolved);
    if (!route) {
      // Resolved, but there is no browser surface for it. Report WHAT it is and
      // that it cannot be opened — never a link into nothing.
      return c.json({
        type: resolved.kind,
        id: resolved.id,
        displayName: resolved.displayName ?? null,
        workspaceId: resolved.workspaceId ?? null,
        openable: false,
      });
    }

    return c.json({
      type: route.label,
      id: resolved.id,
      displayName: resolved.displayName ?? null,
      workspaceId: resolved.workspaceId ?? null,
      ...(resolved.profileSlug ? { profileSlug: resolved.profileSlug } : {}),
      openable: true,
      ...(route.params ? { params: route.params } : {}),
    });
  });
}
