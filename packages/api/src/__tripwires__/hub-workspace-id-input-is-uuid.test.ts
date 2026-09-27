import { describe, it, expect } from "vitest";

/**
 * TRIPWIRE — every Hub REST route that accepts a `workspaceId` INPUT refuses a
 * non-uuid value at the door (400), instead of letting it reach a Postgres
 * `uuid` comparison that throws 22P02 and escapes as a 500.
 *
 * Reproduced live 2026-09-25: `GET /api/hub/entities?workspaceId=notauuid`
 * → 500. The class was 78 request schemas declaring `workspaceId: z.string()`.
 * The canonical validator is `uuidQueryParam` (`rest/_codecs/_openapi.ts`).
 *
 * DERIVED, NOT HAND-LISTED: this walks the LIVE OpenAPI registry of the real
 * `hubProtocolRestApp` — every `app.openapi(route)` the pod mounts — and
 * probes the actual `workspaceId` schema of each route's query, path params
 * and JSON body with `safeParse("notauuid")`. A new route joins the scan by
 * existing; there is no list to forget to update.
 *
 * WHAT IT DOES NOT SEE (measured 2026-09-25):
 *   - plain `app.get/post(...)` handlers (not `app.openapi`) that read
 *     `c.req.query("workspaceId")` raw — no schema exists to probe. Those rely
 *     on per-handler checks (e.g. `resolveActingContext`'s `isUuid`).
 *   - non-JSON bodies (multipart) and a `workspaceId` nested below the top
 *     level of a schema.
 *   - RESPONSE schemas, on purpose: they validate nothing the caller sends.
 */

// Peer-held files on 2026-09-25 were migrated on 2026-09-27 (FX-B2): the
// ratchet is EMPTY. A RATCHET: the test fails if a route listed here becomes
// closed (delete the line) or a NEW open route appears.
const KNOWN_OPEN = new Set<string>([]);

type Probe = { key: string; open: boolean };

async function probeRegistry(): Promise<{ routes: number; probes: Probe[] }> {
  const { hubProtocolRestApp } =
    await import("../routers/hub-protocol-rest.js");
  const defs = (
    hubProtocolRestApp as unknown as {
      openAPIRegistry: { definitions: Array<{ type: string; route?: any }> };
    }
  ).openAPIRegistry.definitions;
  let routes = 0;
  const probes: Probe[] = [];
  for (const d of defs) {
    if (d.type !== "route" || !d.route) continue;
    routes++;
    const r = d.route;
    const locations: Array<[string, any]> = [
      ["query", r.request?.query],
      ["params", r.request?.params],
      ["body", r.request?.body?.content?.["application/json"]?.schema],
    ];
    for (const [loc, schema] of locations) {
      const shape = schema?.shape;
      if (!shape || !("workspaceId" in shape)) continue;
      probes.push({
        key: `${String(r.method).toUpperCase()} ${r.path} [${loc}]`,
        open: shape.workspaceId.safeParse("notauuid").success === true,
      });
    }
  }
  return { routes, probes };
}

describe("tripwire: Hub workspaceId inputs are uuid-validated at the door", () => {
  it("no route accepts a non-uuid workspaceId (except the peer-held ratchet)", async () => {
    const { routes, probes } = await probeRegistry();

    // Non-vacuity: the registry walk must actually be looking at the app.
    // 2026-09-25: 278 openapi routes, 122 workspaceId input schemas.
    expect(routes).toBeGreaterThan(200);
    expect(probes.length).toBeGreaterThan(100);
    // Self-check on a literal sample — the route the live 500 came from.
    expect(probes.map((p) => p.key)).toContain("GET /entities [query]");

    const open = probes
      .filter((p) => p.open)
      .map((p) => p.key)
      .sort();
    const unexpected = open.filter((k) => !KNOWN_OPEN.has(k));
    expect(
      unexpected,
      "use `uuidQueryParam` (rest/_codecs/_openapi.ts) for these workspaceId inputs"
    ).toEqual([]);

    const nowClosed = [...KNOWN_OPEN].filter((k) => !open.includes(k));
    expect(
      nowClosed,
      "these are fixed — remove them from KNOWN_OPEN so the ratchet holds"
    ).toEqual([]);
  }, 120_000);

  it("the shared validator itself: 400-shaped on junk, accepts a uuid and the empty string", async () => {
    const { uuidQueryParam } =
      await import("../routers/hub-protocol/rest/_codecs/_openapi.js");
    expect(uuidQueryParam.safeParse("notauuid").success).toBe(false);
    expect(uuidQueryParam.safeParse("c074e8ac").success).toBe(false);
    // Postgres accepts any version nibble — the door must too.
    expect(
      uuidQueryParam.safeParse("11111111-1111-1111-1111-111111111111").success
    ).toBe(true);
    // `""` = absent by every handler's convention (`query.workspaceId || null`).
    expect(uuidQueryParam.safeParse("").success).toBe(true);
  });

  it("path, query and body validate the SAME stored id the same way (one PG_UUID_RE)", async () => {
    const { uuidQueryParam, uuidParam } =
      await import("../routers/hub-protocol/rest/_codecs/_openapi.js");
    const { uuidPathParam, isUuid } =
      await import("../routers/hub-protocol/rest/_shared.js");
    // A version/variant nibble zod's RFC `.uuid()` refuses but Postgres stores
    // — the input on which the old path validator DISAGREED with query/body.
    const pgOnly = "11111111-1111-1111-1111-111111111111";
    const rfc = "11111111-1111-4111-8111-111111111111";
    for (const id of [pgOnly, rfc]) {
      expect(uuidPathParam.safeParse(id).success).toBe(true);
      expect(uuidParam.safeParse(id).success).toBe(true);
      expect(uuidQueryParam.safeParse(id).success).toBe(true);
      expect(isUuid(id)).toBe(true);
    }
    for (const junk of ["notauuid", "c074e8ac"]) {
      expect(uuidPathParam.safeParse(junk).success).toBe(false);
      expect(isUuid(junk)).toBe(false);
    }
    // Required id: empty is NOT absent on a path.
    expect(uuidPathParam.safeParse("").success).toBe(false);
  });
});
