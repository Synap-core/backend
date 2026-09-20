/**
 * TRIPWIRE — ONE proposal shape on every hub door.
 *
 * The defect this exists to prevent, measured live on pod.antoinesrvt (build
 * b8c0af1e): `POST /api/hub/playbooks/:id/run` answered **202** with
 * `{status:"proposed", proposalId, reviewUrl}` while `POST /api/hub/profiles`
 * answered **200** with no `reviewUrl`, and `POST /api/hub/focus-sessions/:id/
 * complete` answered **403**. Every narrow door (Raycast, CLI, the claude.ai
 * connector) then had to special-case each route, and a client keying on 202 or
 * on `reviewUrl` silently mishandled one of them.
 *
 * The rule: a proposal is SUCCESS — 202, with `proposalId` AND `reviewUrl`.
 * `jsonGoverned` (routers/hub-protocol/proposal-response.ts) is the only place
 * that rule is written down, so this file's job is to prove that no hub door
 * answers a proposal any OTHER way.
 *
 * THREE checks, all with the set DERIVED from source — a route joins the scan
 * by EXISTING, never by being added to a list here:
 *
 *  1. BEHAVIOURAL — `jsonGoverned` itself: 202 + a derived `reviewUrl`, a
 *     gate-supplied link left untouched, a non-proposed body unchanged.
 *  2. LITERAL SITES — every `status: "proposed"` written inline in a REST
 *     handler answers through `jsonGoverned`, never a bare `c.json`.
 *  3. FORWARDERS — every REST handler that forwards a hub tRPC procedure whose
 *     own body can return `status: "proposed"` (that PROCEDURE SET is itself
 *     derived, by scanning the hub tRPC routers) answers through `jsonGoverned`.
 *     This is the half a literal scan is blind to: the handler contains no
 *     `"proposed"` string at all — it just returns what the inner door gave it,
 *     which is exactly how `POST /profiles` shipped its 200.
 *
 * WHAT THIS DOES NOT COVER, measured:
 * - The hub **tRPC** doors (`hubProtocolRouter.channels.createExternalChannel`,
 *   `.bindChannel`, `.branches.createBranch`, `.branches.merge`) have no HTTP
 *   status of their own and no REST forwarder today; they are out of scope by
 *   construction, and check 3 will start covering them the day one is forwarded.
 * - Granularity is the RETURN SITE, not the route: a handler with two proposed
 *   branches where only one regressed is caught, but a handler that stops
 *   returning its result entirely is not a shape question.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { jsonGoverned } from "../proposal-response.js";

const REST_DIR = __dirname;
const HUB_DIR = join(__dirname, "..");

function sourceFiles(dir: string): Array<{ name: string; src: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, src: readFileSync(join(dir, name), "utf8") }));
}

/** `status: "proposed"` / `status: "proposed" as const`, wherever written. */
const PROPOSED_LITERAL = /status:\s*"proposed"/g;

/**
 * Walk back from an offset to the enclosing response call and name it.
 * Returns `"jsonGoverned"`, `"c.json"`, or null when the literal is not inside
 * a response call at all (a comment, a Zod schema, a local variable).
 */
function enclosingResponder(src: string, at: number): string | null {
  let depth = 0;
  for (let j = at; j > 0; j--) {
    const ch = src[j];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        const before = src.slice(Math.max(0, j - 20), j);
        if (before.endsWith("jsonGoverned")) return "jsonGoverned";
        if (before.endsWith("c.json")) return "c.json";
        // Some other call — keep walking outward.
        continue;
      }
      depth--;
    }
  }
  return null;
}

describe("jsonGoverned — the one proposal shape", () => {
  const ctx = () => {
    const seen: { body: unknown; status: unknown } = {
      body: undefined,
      status: undefined,
    };
    const c = {
      json: (body: unknown, status?: unknown) => {
        seen.body = body;
        seen.status = status;
        return new Response("ok");
      },
    } as never;
    return { c, seen };
  };

  it("answers 202 and DERIVES the review link when the inner door dropped it", () => {
    const { c, seen } = ctx();
    jsonGoverned(c, { status: "proposed", proposalId: "prop-1" });
    expect(seen.status).toBe(202);
    expect(seen.body).toEqual({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "/open/prop-1",
    });
  });

  it("never overwrites a link the gate already computed", () => {
    const { c, seen } = ctx();
    jsonGoverned(c, {
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod.example/open/proposal/prop-1",
    });
    expect(seen.status).toBe(202);
    expect((seen.body as { reviewUrl: string }).reviewUrl).toBe(
      "https://pod.example/open/proposal/prop-1"
    );
  });

  it("leaves the DIRECT (auto-approved) branch exactly as the route had it", () => {
    const { c, seen } = ctx();
    jsonGoverned(c, { status: "created", id: "e1" });
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({ status: "created", id: "e1" });
    const two = ctx();
    jsonGoverned(two.c, { ok: true });
    expect(two.seen.status).toBe(200);
  });

  it("does not claim a proposal without an id (no proposalId ⇒ untouched)", () => {
    const { c, seen } = ctx();
    jsonGoverned(c, { status: "proposed" });
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({ status: "proposed" });
  });
});

describe("every hub REST proposal LITERAL answers through jsonGoverned", () => {
  const files = sourceFiles(REST_DIR);

  // Self-check: the scanner can still see what it hunts. A regex that stops
  // matching passes every assertion after it.
  it("the scanner recognises both responders in a literal sample", () => {
    const sample = `return c.json({ status: "proposed", proposalId: p });`;
    const good = `return jsonGoverned(c, { status: "proposed", proposalId: p });`;
    const at = (s: string) => s.search(/status:\s*"proposed"/);
    expect(enclosingResponder(sample, at(sample))).toBe("c.json");
    expect(enclosingResponder(good, at(good))).toBe("jsonGoverned");
  });

  it("finds a plausible number of proposal literals (non-vacuity floor)", () => {
    const withLiterals = files.filter((f) =>
      /status:\s*"proposed"/.test(f.src)
    );
    const total = files.reduce(
      (n, f) => n + (f.src.match(PROPOSED_LITERAL)?.length ?? 0),
      0
    );
    // 25 sites across 15 files at the time of writing. A collapse to near-zero
    // means the glob or the regex stopped seeing the code, not that the codebase
    // stopped proposing.
    expect(files.length).toBeGreaterThan(50);
    expect(withLiterals.length).toBeGreaterThanOrEqual(12);
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it("no proposal literal is answered by a bare c.json", () => {
    const offenders: string[] = [];
    for (const { name, src } of files) {
      for (const m of src.matchAll(PROPOSED_LITERAL)) {
        const responder = enclosingResponder(src, m.index);
        if (responder === "c.json") {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${name}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every hub REST forwarder of a proposal-capable tRPC door uses jsonGoverned", () => {
  /** Procedure declarations, sliced so each name owns the body up to the next. */
  function proceduresWithProposalLiteral(dir: string): Set<string> {
    const found = new Set<string>();
    for (const { src } of sourceFiles(dir)) {
      for (const [name, slice] of procedureSlices(src)) {
        if (/status:\s*"proposed"/.test(slice)) found.add(name);
      }
    }
    return found;
  }

  function procedureSlices(src: string): Array<[string, string]> {
    const decls = [
      ...src.matchAll(
        /^ {2}(\w+):\s*(?:scoped|public|protected|workspace)Procedure/gm
      ),
    ];
    return decls.map((d, i) => [
      d[1],
      src.slice(
        d.index,
        i + 1 < decls.length ? decls[i + 1].index : src.length
      ),
    ]);
  }

  /**
   * DERIVED, in two hops — because the one-hop version has a blind spot that
   * shipped the original defect. `hubProfilesRouter.createProfile` contains no
   * `"proposed"` literal at all: it DELEGATES to the core `profilesRouter`,
   * which proposes. A scan of the hub routers alone therefore called it safe,
   * which is exactly the door that answered 200 without a `reviewUrl`.
   *
   * Hop 1: core routers (`routers/*.ts`) → procedure names that propose.
   * Hop 2: hub routers → a procedure is proposal-capable if it proposes itself
   *        OR it calls one of the hop-1 names.
   * Both sets are read off the source, so a new governed procedure joins by
   * existing. Hop 2 deliberately OVER-approximates (a hub proc calling any
   * same-named core proc counts): `jsonGoverned` is a no-op on a body that is
   * not proposed, so a false positive costs nothing and a false negative is the
   * bug.
   */
  const proposalProcedures = (() => {
    const core = proceduresWithProposalLiteral(join(HUB_DIR, ".."));
    const found = proceduresWithProposalLiteral(HUB_DIR);
    for (const { src } of sourceFiles(HUB_DIR)) {
      for (const [name, slice] of procedureSlices(src)) {
        for (const call of slice.matchAll(/\.(\w+)\(\{/g)) {
          if (core.has(call[1])) found.add(name);
        }
      }
    }
    return found;
  })();

  it("derives a plausible set of proposal-capable procedures", () => {
    // createProfile (via delegation), createDocument, createDocumentProposal,
    // updateView, arrangeBento, upsertWidgetDef, setRenderer, createPropertyDef,
    // createExternalChannel, bindChannel, createBranch, mergeBranch … today.
    expect(proposalProcedures.size).toBeGreaterThanOrEqual(8);
    // The delegating case — the one a single-hop scan misses.
    expect(proposalProcedures.has("createProfile")).toBe(true);
    // The self-proposing case.
    expect(proposalProcedures.has("updateView")).toBe(true);
  });

  it("no REST handler returns such a result through a bare c.json", () => {
    const offenders: string[] = [];
    let forwards = 0;
    for (const { name, src } of sourceFiles(REST_DIR)) {
      const calls = [
        ...src.matchAll(/const (\w+) = await caller\.(?:\w+)\.(\w+)\(/g),
      ];
      for (const call of calls) {
        const [, varName, proc] = call;
        if (!proposalProcedures.has(proc)) continue;
        forwards++;
        // Classify by the FIRST return of that variable after the call — a
        // fixed-size window spills into the NEXT handler and reads its
        // `return c.json(result)` as this one's (observed while writing this).
        const tail = src.slice(call.index);
        // Both the plain forward `c.json(result)` AND the RESHAPED forward
        // `c.json({ ...result, extra })`. The reshape is not a corner case: it
        // is how `POST /entities` and `PATCH /entities/:id` escaped the first
        // version of this scan — they spread the governed result into a new
        // object, so neither the literal scan nor a `c.json(result)` pattern
        // could see them, and both answered 200 on a proposal.
        const bare = tail.search(
          new RegExp(
            `return c\\.json\\(\\s*\\{?\\s*(\\.\\.\\.)?${varName}[),.\\s]`
          )
        );
        const governed = tail.search(
          new RegExp(
            `return jsonGoverned\\(c, \\s*\\{?\\s*(\\.\\.\\.)?${varName}[),.\\s]`
          )
        );
        if (bare !== -1 && (governed === -1 || bare < governed)) {
          const line = src.slice(0, call.index).split("\n").length;
          offenders.push(`${name}:${line} (${proc} → ${varName})`);
        }
      }
    }
    // Non-vacuity: 10 such forwards exist today (views ×3, documents ×4,
    // profiles ×2, widget-definitions ×1). Zero means the call-shape regex
    // stopped matching, not that the forwards disappeared.
    expect(forwards).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });
});
