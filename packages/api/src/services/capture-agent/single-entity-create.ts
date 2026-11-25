/**
 * A capture of exactly ONE plain entity is a typed create, not an import graph.
 *
 * `synap_capture({ entities: [one] })` used to file EVERY structured payload as
 * an `import.graph` proposal, so a single founder decision landed in the review
 * queue as an "import request". The typed create door (`synap_create_entity` ->
 * `entities.create`) already files that very write as a `create` proposal on
 * target `entity`, through `checkPermissionOrPropose()`, with a card that reads
 * "Create Decision ...". This module decides WHEN a capture is that write, and
 * maps the typed door's answer onto the capture receipt. It writes nothing:
 * the write is the typed door's, reused (never a parallel create).
 *
 * PURE and dependency-free on purpose (see `capture-receipt-state.ts`): a test
 * that mocks the submit core must not be able to stub the routing away.
 *
 * What stays on the graph (all-or-none, or something the typed door cannot do):
 *   - two or more entities, any relation, any plan step: the graph's contract;
 *   - `existingEntityId`: a LINK. `entities.create` cannot link an existing row
 *     (it creates or dedups by identity), so the graph's link op is the only
 *     door that expresses it;
 *   - a facet carrying `status` or `contextRef`: the typed door's facet input
 *     is `{ slug, properties }` and would silently drop both;
 *   - `text` sent beside the entity: the graph keeps that text as `rawSource`
 *     provenance and stages it as an intake source; the typed door has neither;
 *   - an entity without a usable title: the graph falls back to its `ref`.
 */

export interface SingleEntityRoutingInput {
  entities: ReadonlyArray<Record<string, unknown>>;
  relationCount: number;
  planStepCount: number;
  /** Normalized `text` that rode alongside `entities[]` ("" when none). */
  text: string;
}

export type SingleEntityRouting =
  | { route: "typed-create"; args: Record<string, unknown> }
  | { route: "graph"; reason: string };

const graph = (reason: string): SingleEntityRouting => ({
  route: "graph",
  reason,
});

/** The typed `synap_create_entity` arguments for a single plain entity, or why not. */
export function routeSingleEntityCapture(
  input: SingleEntityRoutingInput
): SingleEntityRouting {
  if (input.entities.length !== 1) return graph("not-exactly-one-entity");
  if (input.relationCount > 0) return graph("has-relations");
  if (input.planStepCount > 0) return graph("has-plan-steps");
  if (input.text) return graph("text-provenance");
  const e = input.entities[0]!;
  if (e.existingEntityId) return graph("existing-entity-link");
  if (typeof e.profileSlug !== "string" || !e.profileSlug)
    return graph("no-profile");
  if (typeof e.title !== "string" || !e.title.trim()) return graph("no-title");

  const facets: Array<{ slug: string; properties?: Record<string, unknown> }> =
    [];
  if (e.facets !== undefined) {
    if (!Array.isArray(e.facets)) return graph("facets-shape");
    for (const f of e.facets as Array<Record<string, unknown>>) {
      if (!f || typeof f !== "object" || typeof f.profileSlug !== "string")
        return graph("facets-shape");
      if (f.status !== undefined || f.contextRef !== undefined)
        return graph("facet-status-or-context");
      facets.push({
        slug: f.profileSlug,
        ...(f.properties && typeof f.properties === "object"
          ? { properties: f.properties as Record<string, unknown> }
          : {}),
      });
    }
  }

  return {
    route: "typed-create",
    args: {
      profileSlug: e.profileSlug,
      title: e.title,
      ...(typeof e.description === "string" && e.description
        ? { description: e.description }
        : {}),
      ...(typeof e.content === "string" && e.content
        ? { content: e.content }
        : {}),
      ...(e.properties && typeof e.properties === "object"
        ? { properties: e.properties }
        : {}),
      ...(facets.length ? { facets } : {}),
    },
  };
}

/** The word the typed door's receipt state becomes on a capture receipt. */
export function captureStatusForCreateState(
  state: "pending" | "applied" | "partial" | "no_effect" | undefined
): "proposed" | "applied" | "partial" | "no_effect" {
  // An absent state is never read as success: say nothing happened.
  if (!state) return "no_effect";
  return state === "pending" ? "proposed" : state;
}
