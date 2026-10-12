/**
 * PRESENCE is not CHANGE — for every door that demotes an approval.
 *
 * Three doors reset an approval when "an execution-defining field changed", and
 * all three tested PRESENCE (`fields[k] !== undefined`). A presence test is
 * wrong wherever a caller re-sends an unchanged field, which is what a
 * full-object form save always does — both live UIs do exactly that:
 *   - `WorkspaceSection.tsx` `saveEdit()` re-sends transport/command/args/url on
 *     EVERY MCP-server save, so a rename or an enabled-toggle silently set
 *     `approved: false` and pulled that server's tools out of LLM requests.
 *   - `CapabilitiesSurface.tsx` re-sends `credentialRef` (hydrated from the row)
 *     on every tool save, so a NAME-ONLY edit looked egress-changing: it
 *     proposal-gated a benign rename and reset `approved`.
 * `skillsRouter.update` was the same bug, fixed first; this pins the other two
 * against the identical regression.
 *
 * SOURCE PARITY, not a re-listed copy: the field lists are legitimately
 * DIFFERENT per entity (a skill's execution surface is not a tool's is not an
 * MCP server's), so they stay next to their entity and are read back OUT of the
 * source here. What must be shared — and is asserted — is the one comparison
 * rule, `execFieldsChanged`. The MCP-server list lives in `skill-exec-fields.ts`
 * (`MCP_SERVER_RE_APPROVAL_FIELDS`) because the template applier rewrites the
 * same columns and must demote by the same list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { execFieldsChanged } from "./skill-exec-fields.js";

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, "..", "..");
const routers = join(apiSrc, "routers");
const mcpSample = {
  command: "npx",
  args: ["-y", "server"],
  env: { A: "1", B: "2" },
  url: "https://example.test/mcp",
  transport: "stdio",
  auth: { credentialRef: "vault://x", header: "Authorization" },
} as Record<string, unknown>;

const DOORS = [
  {
    file: "tools.ts",
    /** Where the door's field list is declared, and under which name. */
    fieldsFile: join(routers, "tools.ts"),
    listName: "RE_APPROVAL_FIELDS",
    /** The row column each patch key is compared against, for the value test. */
    sample: {
      credentialRef: "vault:stripe",
      config: { a: 1, b: 2 },
      executor: "http",
      kind: "api",
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    } as Record<string, unknown>,
  },
  {
    file: "mcp-servers.ts",
    fieldsFile: join(here, "skill-exec-fields.ts"),
    listName: "MCP_SERVER_RE_APPROVAL_FIELDS",
    sample: mcpSample,
  },
  {
    // The capability applier rewrites the same mcp_servers columns on re-apply.
    file: "../services/capabilities/create-from-definition.ts",
    fieldsFile: join(here, "skill-exec-fields.ts"),
    listName: "MCP_SERVER_RE_APPROVAL_FIELDS",
    sample: mcpSample,
  },
] as const;

/** Every non-test .ts under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("the DOORS list is every caller of execFieldsChanged", () => {
  // DERIVED, not trusted: a new door that demotes through the shared rule
  // joins the scan by existing. `skill-exec-fields.ts` is the rule's own home
  // (its skill wrapper is pinned by skill-exec-fields.tripwire.test.ts).
  const CALL = /(?<![\w.])execFieldsChanged\(/;
  const callers = sourceFiles(apiSrc)
    .filter((f) => !f.endsWith("skill-exec-fields.ts"))
    .filter((f) => CALL.test(readFileSync(f, "utf8")))
    .sort();

  it("finds the callers it hunts (non-vacuity)", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
    expect(CALL.test("const execChanged = execFieldsChanged(")).toBe(true);
    expect(CALL.test("skillExecFieldsChanged(")).toBe(false);
  });

  // Callers that are NOT approval doors, each with the reason and where it is
  // pinned instead. A caller must be in DOORS or here — never in neither.
  const NOT_APPROVAL_DOORS: Record<string, string> = {
    [join(apiSrc, "services/cells/define-cell.ts")]:
      "demotes a cell's trustLevel on an externalHosts change, not `approved` — " +
      "pinned by define-cell.external-hosts.test.ts",
  };

  it("classifies each one as a door or a named non-door", () => {
    expect(callers).toEqual(
      [
        ...DOORS.map((d) => join(routers, d.file)),
        ...Object.keys(NOT_APPROVAL_DOORS),
      ].sort()
    );
  });
});

/** The `<listName> = [...] as const` literal, read out of the source. */
function declaredFields(src: string, file: string, listName: string): string[] {
  const m = new RegExp(`const ${listName} = \\[([^\\]]*)\\]`).exec(src);
  expect(m, `${file} no longer declares its ${listName} list`).not.toBeNull();
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe.each(DOORS)(
  "$file demotes on VALUE, not PRESENCE",
  ({ file, fieldsFile, listName, sample }) => {
    const src = readFileSync(join(routers, file), "utf8");
    const fields = declaredFields(
      readFileSync(fieldsFile, "utf8"),
      file,
      listName
    );

    const WHY =
      `${file} must decide demotion with execFieldsChanged(RE_APPROVAL_FIELDS, patch, existing). ` +
      `A presence test (\`fields[k] !== undefined\`) un-approves the row whenever a caller ` +
      `re-sends an unchanged field, which every full-object form save does.`;

    // Anchored on the CALL, not the import line — `indexOf("execFieldsChanged(")`
    // alone finds the import and would pass vacuously.
    const CALL = "const execChanged = execFieldsChanged(";
    const callIdx = src.indexOf(CALL);

    it("computes the decision through the shared execFieldsChanged", () => {
      expect(callIdx, WHY).toBeGreaterThan(-1);
    });

    it("passes the field list and the already-loaded existing row", () => {
      const args = src.slice(callIdx, src.indexOf(");", callIdx));
      expect(args, WHY).toContain(listName);
      expect(args, WHY).toContain("existing");
    });

    it("keeps no presence test over the field list", () => {
      // `[^)]*` would stop at the `)` of the `(k) =>` arrow — match anything.
      expect(
        /RE_APPROVAL_FIELDS\.some\([\s\S]{0,200}?!==\s*undefined/.test(src),
        WHY
      ).toBe(false);
    });

    it("wires that decision to the approval write, and only that way", () => {
      // The three assertions above prove the door COMPUTES the right answer.
      // None of them proved it USES it. A door that calls execFieldsChanged and
      // then ignores the result — or inverts it — would pass every check above
      // while leaving the live defect (a rename un-approving the row) exactly
      // where it was. This is the only assertion that reaches the consequence.
      expect(
        /execChanged\s*\?\s*\{\s*approved:\s*false\s*\}/.test(src),
        `${file} must spread \`...(execChanged ? { approved: false } : {})\` into its ` +
          `update .set(). Computing the demotion and not writing it is the same bug ` +
          `with extra steps.`
      ).toBe(true);
      // Scoped to THIS mutation's `.set()`, not the file: `tools.ts` also has a
      // legitimate sibling demotion in `setAuthBinding` (`bindingChanged ?
      // { approved: false }`) for a field the update door does not accept, and
      // it already compares by VALUE. A file-wide count would flag that as a
      // fork. What must not exist is a SECOND demotion inside this update.
      // Bound it by brace-matching the FIRST `.set({` after the call, so the
      // window is the real mutation body rather than a guessed char count (the
      // call sits ~80 lines above its own `.set()` in tools.ts).
      const setStart = src.indexOf(".set({", callIdx);
      expect(
        setStart,
        `${file}: no .set({ found after the execChanged call`
      ).toBeGreaterThan(-1);
      let depth = 0;
      let setEnd = setStart;
      for (let i = src.indexOf("{", setStart); i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) {
            setEnd = i;
            break;
          }
        }
      }
      const setBlock = src.slice(setStart, setEnd);
      const demotions = [...setBlock.matchAll(/approved:\s*false/g)].length;
      expect(
        demotions,
        `${file}'s update .set() has ${demotions} \`approved: false\` writes; exactly ` +
          `one is expected (the execChanged spread). A second is a second rule.`
      ).toBe(1);
    });

    it("every declared field is covered by the value sample below", () => {
      // Guards the sample from silently going stale when a field is added.
      expect(Object.keys(sample).sort()).toEqual([...fields].sort());
    });

    it("a byte-identical re-send does NOT demote", () => {
      // jsonb hands object keys back in a different order than they went in.
      const existing = JSON.parse(JSON.stringify(sample)) as Record<
        string,
        unknown
      >;
      if (existing.config) existing.config = { b: 2, a: 1 };
      if (existing.env) existing.env = { B: "2", A: "1" };
      expect(
        execFieldsChanged(fields, { ...sample, name: "renamed" }, existing)
      ).toBe(false);
    });

    it.each(fields)("a changed %s DOES demote", (field) => {
      const patch = {
        ...sample,
        [field]: Array.isArray(sample[field]) ? ["other"] : "CHANGED",
      };
      expect(execFieldsChanged(fields, patch, sample)).toBe(true);
    });
  }
);
