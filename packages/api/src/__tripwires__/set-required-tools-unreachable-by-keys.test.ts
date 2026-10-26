/**
 * TRIPWIRE — the writer of a skill's `requires → tool` edges
 * (`replaceSkillRequiredTools`, the body of `skills.setRequiredTools`) is never
 * an ungoverned scope grant for an API key.
 *
 * Those edges ARE a scope: a code skill's own provider calls to the tools it
 * `requires` run under its decision with no second review (`verbAct`,
 * execute-capability.ts). So every source that reaches the writer is listed
 * below with WHY a key cannot widen an approved skill's scope through it, and
 * the test that drives it. The set is DERIVED: every non-test source under
 * `packages/api/src` that calls `.setRequiredTools(` or
 * `replaceSkillRequiredTools(` (routers, services, executors, REST and MCP
 * alike). A new caller turns this red until it is classified here.
 *
 * Door by door (review of #199, M4, corrected by review R2):
 *  - main `/trpc`: every non-public procedure needs a Kratos SESSION
 *    (`apps/api/src/trpc-session-gate.ts`, tested there) — a key cannot call
 *    `skills.setRequiredTools`;
 *  - hub tRPC (`/api/hub/trpc`, key auth) serves `hubProtocolRouter`, which has
 *    no such procedure (asserted below, from the router's own procedure map);
 *  - hub REST `POST /skills` and MCP `synap_create_skill`: `requires` rides the
 *    governed create as `requiredToolIds` (proposal or granted create);
 *  - MCP `synap_create_verb` → `wireCreatedVerb`: only after a governed
 *    `created`, only the visibility-checked parent tool;
 *  - hub REST `POST /api/hub/capabilities/apply` → the definition applier: IS a
 *    key door. A NEW skill is created through the governed create; an EXISTING
 *    approved skill whose `requires` ADDS a tool is demoted to unapproved, like
 *    any execution change, so the widened scope needs a person again.
 *
 * Does NOT cover: granularity is the FILE. A second call added inside an
 * already-classified file stays green; the proof test, not this scan, is what
 * must see it. The proof check reads that the test imports the caller's
 * module, not that it reaches the call.
 *
 * Negative control (2026-10-26, negctl/tickets-1025-8): a REST route
 * (`skills-crud.ts`) mentioning `caller.setRequiredTools(...)` turns
 * "every source reaching the requires writer is classified" red.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});

import { hubProtocolRouter } from "../routers/hub-protocol/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const CALL = /\.setRequiredTools\(|\breplaceSkillRequiredTools\(/;

/**
 * Every source that reaches the writer → why a key cannot widen an approved
 * skill's scope through it, and the test (relative to `src`) that drives it.
 */
const CLASSIFIED: Record<string, { why: string; proof: string }> = {
  "routers/skills.ts": {
    why: "the session-only procedure itself, and `skills.create` writing the declared set only after its gate granted the create",
    proof: "routers/skills.create-required-tools.test.ts",
  },
  "routers/proposals/executors/skill.ts": {
    why: "the `skill/create` approval: a person approved the named tools; ids re-resolved as the approver",
    proof: "routers/proposals/__tests__/skill-create-approval-wiring.test.ts",
  },
  "services/capabilities/create-declarative-verb.ts": {
    why: "`wireCreatedVerb`: only after a governed `created`, only the visibility-checked parent tool",
    proof: "routers/capabilities.create-verb-wiring.test.ts",
  },
  "services/capabilities/create-from-definition.ts": {
    why: "the definition applier (a key door): a widened `requires` on an existing approved skill demotes it",
    proof:
      "services/capabilities/create-from-definition.requires-widening.pglite.test.ts",
  },
};

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!e.name.endsWith(".ts") || e.name.includes(".test.")) return [];
    return [{ file: p, text: readFileSync(p, "utf8") }];
  });
}

describe("tripwire: an API key cannot widen a skill's `requires` scope", () => {
  it("the key-auth hub tRPC router has no setRequiredTools procedure", () => {
    const procedures = Object.keys(
      (hubProtocolRouter as unknown as { _def: { procedures: object } })._def
        .procedures
    );
    // Non-vacuity: it is the real router, with its skills namespace.
    expect(procedures.length).toBeGreaterThan(50);
    expect(procedures.some((p) => p.startsWith("skills."))).toBe(true);
    expect(procedures.filter((p) => p.endsWith("setRequiredTools"))).toEqual(
      []
    );
  });

  it("every source reaching the requires writer is classified", () => {
    const files = sources(SRC);
    // Non-vacuity: the whole tree was read (REST and MCP handlers included),
    // and the scan sees both spellings of a call.
    expect(files.length).toBeGreaterThan(500);
    expect(
      files.some((f) => f.file.includes("/routers/hub-protocol/rest/"))
    ).toBe(true);
    expect(files.some((f) => f.file.includes("/routers/mcp/handlers/"))).toBe(
      true
    );
    expect(CALL.test("await caller.setRequiredTools({ skillId })")).toBe(true);
    expect(CALL.test("await replaceSkillRequiredTools({ userId })")).toBe(true);

    const callers = files
      .filter((f) => CALL.test(f.text))
      .map((f) => relative(SRC, f.file))
      .sort();
    expect(callers).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it.each(Object.entries(CLASSIFIED))(
    "%s has a test that drives it",
    (caller, { proof }) => {
      const path = resolve(SRC, proof);
      expect(existsSync(path), `${proof} is missing`).toBe(true);
      const module = basename(caller).replace(/\.ts$/, ".js");
      expect(readFileSync(path, "utf8")).toMatch(
        new RegExp(`(from |import\\()"[^"]*/${module.replace(".", "\\.")}"`)
      );
    }
  );
});
