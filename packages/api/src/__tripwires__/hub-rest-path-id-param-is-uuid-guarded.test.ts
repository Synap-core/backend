import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — every Hub REST route with an id-shaped PATH param (`:id`,
 * `:workspaceId`, `:projectId`, …) that reaches a Postgres `uuid` column
 * guards it at the door, so a non-uuid value gives 400 instead of Postgres
 * throwing `invalid input syntax for type uuid` (22P02) and the route's
 * catch mapping that to a bare 500.
 *
 * Reproduced live 2026-09-27: `GET /api/hub/projects/:id` and
 * `GET /api/hub/workspaces/:workspaceId`.
 *
 * WHY THIS IS A DIFFERENT SCAN FROM `hub-workspace-id-input-is-uuid.test.ts`:
 * that tripwire walks the LIVE `openAPIRegistry` and probes each route's zod
 * schema — but it only sees routes wired with the REAL validating
 * `app.openapi(routeDef, handler)`. Only 9 of ~50 `rest/*.ts` files use that.
 * Everywhere else, `registerOpenApi()` (`_codecs/_register.ts`) registers
 * OpenAPI *documentation* on a SEPARATE plain `app.get/post/patch/delete`
 * handler — the schema it declares is NEVER enforced at runtime. A doc-only
 * `params: { id: uuidParam }` can sit right next to a handler reading
 * `c.req.param("id")` raw. This tripwire is the SOURCE-derived scan that
 * covers that blind spot: it parses the actual `rest/*.ts` route
 * registrations (not the doc registry) and checks the handler source for a
 * guard.
 *
 * DERIVED, NOT HAND-LISTED: globs every non-test `rest/*.ts` file, regexes
 * out each `app.<method>("path"/`path`)` registration, and extracts every
 * `:param` whose name is `id`-shaped (`id` or `*Id`). A new route or a new
 * id-shaped param joins the scan by existing.
 *
 * A route block counts as GUARDED when it calls `requireUuidParam(c, ...)`
 * (the canonical helper, `rest/_shared.ts`), `isUuid(...)`, a `Uuid.safeParse`
 * codec, or an inline `z...uuid().../safeParse(...)` check.
 *
 * WHAT IT DOES NOT SEE (measured 2026-09-27, each one checked BY HAND — see
 * `KNOWN_SAFE_ELSEWHERE`):
 *   - a route that delegates the id to a tRPC procedure whose OWN input
 *     schema is `z.string().uuid()` (the procedure 400s via
 *     `httpStatusForTrpcError` before any query runs) — the guard then lives
 *     in a DIFFERENT file this scan does not read.
 *   - a route with its own bespoke dual-format dispatch (e.g.
 *     `/channels/:channelId/context-card` accepts either the Synap uuid OR a
 *     Discord snowflake, and branches the query on an inline regex test
 *     before ever comparing to the uuid column) — safe by construction, just
 *     not spelled with one of the four guard idioms above.
 *   - non-JSON bodies, response schemas, and any id embedded below the path
 *     level (e.g. inside a JSON body).
 *   - a param genuinely NOT bound to a uuid column (`EXCLUDE_PARAMS`, each
 *     with the schema/text-column evidence in the comment below) — these are
 *     excluded from the scan entirely, not silently passed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REST_DIR = path.resolve(HERE, "../routers/hub-protocol/rest");

/**
 * Path params that are id-shaped by NAME but are NOT a caller-supplied id
 * bound to a Postgres `uuid` column, verified against the schema/handler on
 * 2026-09-27:
 *   - token        — `calendar_feed_tokens`/`public_shares`/`public_forms`
 *                     tokens are `text`, opaque, not uuid.
 *   - typeKey      — `widget_definitions.type_key` is `text`.
 *   - kind         — `workflows` route discriminator ("automation" |
 *                     "playbook"), not a row id.
 *   - stageKey     — track stage key, `text`.
 *   - slug         — profile/agent-skill slug, `text`.
 *   - externalChannelId / messageId — Discord/provider-native ids
 *                     (`channels.external_channel_id` is `text`); comparing
 *                     them to a uuid column is never attempted.
 *   - sectionId    — an identifier inside a document's JSON section list,
 *                     not a database row id.
 *   - type         — `/graph/:type/:id` entity-kind discriminator, not an id.
 *   - userId       — `/users/:userId/context` floors on
 *                     `assertMayActAs(ctx, userId)`: a MISMATCHED (hence any
 *                     malformed) value 403s via strict string equality
 *                     BEFORE any uuid-column query runs, so a non-uuid value
 *                     can never reach Postgres.
 */
const EXCLUDE_PARAMS = new Set([
  "token",
  "typeKey",
  "kind",
  "stageKey",
  "slug",
  "externalChannelId",
  "messageId",
  "sectionId",
  "type",
  "userId",
]);

/**
 * Routes where the scan sees no local guard idiom but the id IS safe,
 * verified by hand on 2026-09-27 (see file-header "WHAT IT DOES NOT SEE").
 * A RATCHET: removing a line here without the route actually changing is a
 * regression; the tripwire will not catch that removal on its own — the
 * safety claim here is asserted by static tRPC-schema/handler inspection,
 * not re-verified by this scan on every run.
 */
const KNOWN_SAFE_ELSEWHERE = new Set<string>([
  // channels.ts: dual uuid/snowflake dispatch, `isUuid` computed inline and
  // the query branches on it — never compares a non-uuid to the uuid column.
  "GET /channels/:channelId/context-card [channelId]",
  // automations.ts: all 5 delegate to hub-protocol/automations.ts tRPC
  // procedures whose input schema is `id: z.string().uuid()`.
  "GET /automations/:automationId [automationId]",
  "POST /automations/:automationId/trigger [automationId]",
  "PATCH /automations/:automationId [automationId]",
  "POST /automations/:automationId/activate [automationId]",
  "POST /automations/:automationId/pause [automationId]",
  // playbooks.ts PATCH: delegates to hub-protocol/playbooks.ts
  // `updateInputSchema` = `id: z.string().uuid()`.
  "PATCH /playbooks/:id [id]",
  // proposals.ts: all 5 resolve `:id` through `resolveProposalId` (_shared.ts)
  // FIRST — the git-style short-id resolver already in this codebase
  // (`_shared.resolveProposalId.test.ts`). It passes a full uuid straight
  // through, resolves an unambiguous hex prefix, and throws NOT_FOUND
  // (→ 404, not 500) for anything else — so a `requireUuidParam` guard here
  // would be WRONG, not just redundant: it would 400 a legitimate short id
  // the CLI prints and callers paste back. Caught by hand (not by a test)
  // after a first pass wrongly added the guard here — reverted.
  "GET /proposals/:id [id]",
  "PATCH /proposals/:id [id]",
  "POST /proposals/:id/revert [id]",
  "POST /proposals/:id/approve [id]",
  "POST /proposals/:id/reject [id]",
]);

/**
 * Routes where an id-shaped-by-NAME path param is genuinely NOT the uuid
 * `id` column — excluded from the "must guard" requirement entirely (not
 * merely "guarded elsewhere"). Each entry is evidence, not a hunch:
 *   - ai-providers.ts: `:id` binds to `aiProviders.providerId`, a `text`
 *     unique slug (`packages/database/src/schema/ai-providers.ts`), never
 *     `aiProviders.id` (the uuid PK). Caught live by
 *     `ai-providers.governance.test.ts`'s `404s instead of reporting ok on a
 *     no-op UPDATE` test after a first (wrong) pass added
 *     `requireUuidParam` here — reverted.
 */
const ROUTE_PARAM_EXCLUDE = new Set<string>([
  "POST /ai-providers/:id/${suffix} [id]",
  "POST /ai-providers/:id/probe [id]",
  "DELETE /ai-providers/:id [id]",
]);

/**
 * Peer-dirty files at scan-authoring time (2026-09-27) that this tripwire
 * skips rather than false-alarming on someone else's in-flight edit. Remove
 * an entry once that file's guards have actually been reviewed.
 */
const SKIP_FILES = new Set<string>([]);

const ROUTE_RE = /app\.(get|post|patch|put|delete)\(\s*[`"]([^`"]+)[`"]/g;
const GUARD_IDIOMS = [
  /requireUuidParam\(c/,
  /isUuid\(/,
  /Uuid\.safeParse/,
  // An inline `z.object({ x: z.string().uuid() }).safeParse(...)` codec —
  // order-independent (declaration and `.safeParse(` call can be many lines
  // apart) but both must be present in the same route block.
  (block: string) => /\.uuid\(\)/.test(block) && /\.safeParse\(/.test(block),
];

interface Finding {
  key: string;
  file: string;
  guarded: boolean;
}

function scan(): { files: number; routes: number; findings: Finding[] } {
  const files = fs
    .readdirSync(REST_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  let routes = 0;
  const findings: Finding[] = [];

  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    const src = fs.readFileSync(path.join(REST_DIR, file), "utf8");
    const matches: Array<{ index: number; method: string; route: string }> = [];
    for (const m of src.matchAll(ROUTE_RE)) {
      matches.push({
        index: m.index ?? 0,
        method: m[1].toUpperCase(),
        route: m[2],
      });
    }
    for (let i = 0; i < matches.length; i++) {
      routes++;
      const { method, route, index } = matches[i];
      const params = [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      const idShaped = params.filter(
        (p) => (p === "id" || p.endsWith("Id")) && !EXCLUDE_PARAMS.has(p)
      );
      if (idShaped.length === 0) continue;

      const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
      const block = src.slice(index, end);

      for (const p of idShaped) {
        // The route must actually READ this param in its handler (not just
        // name it in the path) for the finding to be meaningful. A FIXED
        // route no longer calls `c.req.param(p)` at all — it reads
        // `requireUuidParam(c, p)` instead — so both forms count as "reads
        // it".
        const reads =
          block.includes(`param("${p}")`) ||
          block.includes(`param('${p}')`) ||
          block.includes(`requireUuidParam(c, "${p}")`) ||
          block.includes(`requireUuidParam(c, '${p}')`);
        if (!reads) continue;
        const key = `${method} ${route} [${p}]`;
        if (ROUTE_PARAM_EXCLUDE.has(key)) continue;
        const guarded = GUARD_IDIOMS.some((idiom) =>
          typeof idiom === "function" ? idiom(block) : idiom.test(block)
        );
        findings.push({
          key,
          file,
          guarded,
        });
      }
    }
  }

  return { files: files.length, routes, findings };
}

describe("tripwire: Hub REST id-shaped path params are uuid-guarded before Postgres", () => {
  it("no route reads an unguarded id-shaped path param (except KNOWN_SAFE_ELSEWHERE)", () => {
    const { files, routes, findings } = scan();

    // Non-vacuity: the scan must actually be walking real route files.
    expect(files).toBeGreaterThan(30);
    expect(routes).toBeGreaterThan(100);
    expect(findings.length).toBeGreaterThan(35);
    // Self-check on the two live-bug routes this tripwire exists to catch.
    expect(findings.map((f) => f.key)).toContain("GET /projects/:id [id]");
    expect(findings.map((f) => f.key)).toContain(
      "GET /workspaces/:workspaceId [workspaceId]"
    );

    const unguarded = findings
      .filter((f) => !f.guarded)
      .map((f) => f.key)
      .sort();
    const unexpected = unguarded.filter((k) => !KNOWN_SAFE_ELSEWHERE.has(k));
    expect(
      unexpected,
      "guard with requireUuidParam(c, name) (rest/_shared.ts) before the param " +
        "reaches a query — or add to EXCLUDE_PARAMS/KNOWN_SAFE_ELSEWHERE with " +
        "the evidence, if it is genuinely not a uuid-column id"
    ).toEqual([]);

    const nowGuarded = [...KNOWN_SAFE_ELSEWHERE].filter(
      (k) => !unguarded.includes(k)
    );
    expect(
      nowGuarded,
      "these now show a local guard idiom too — fine, but drop them from " +
        "KNOWN_SAFE_ELSEWHERE so the ratchet stays honest about what it means"
    ).toEqual([]);
  });

  it("the two live-evidence routes actually guard with requireUuidParam", async () => {
    const projectsSrc = fs.readFileSync(
      path.join(REST_DIR, "projects.ts"),
      "utf8"
    );
    const workspacesSrc = fs.readFileSync(
      path.join(REST_DIR, "workspaces.ts"),
      "utf8"
    );
    expect(projectsSrc).toMatch(
      /app\.get\("\/projects\/:id", async \(c\) => \{\s*const userId = c\.get\("userId"\);\s*const id = requireUuidParam\(c, "id"\);/
    );
    expect(workspacesSrc).toMatch(
      /app\.get\("\/workspaces\/:workspaceId", async \(c\) => \{[\s\S]{0,400}const workspaceId = requireUuidParam\(c, "workspaceId"\);/
    );
  });

  it("requireUuidParam itself: 400-shaped on junk, accepts a uuid, refuses empty", async () => {
    const { requireUuidParam } =
      await import("../routers/hub-protocol/rest/_shared.js");
    const fakeC = (paramValue: string | undefined) =>
      ({
        req: { param: () => paramValue },
        json: (body: unknown, status: number) => ({
          body,
          status,
        }),
      }) as unknown as Parameters<typeof requireUuidParam>[0];

    const junk = requireUuidParam(fakeC("not-a-uuid"), "id");
    expect(junk).not.toBe("not-a-uuid");
    expect((junk as unknown as { status: number }).status).toBe(400);

    const empty = requireUuidParam(fakeC(undefined), "id");
    expect((empty as unknown as { status: number }).status).toBe(400);

    const pgOnly = "11111111-1111-1111-1111-111111111111"; // PG-valid, RFC-invalid nibble
    const ok = requireUuidParam(fakeC(pgOnly), "id");
    expect(ok).toBe(pgOnly);
  });
});
