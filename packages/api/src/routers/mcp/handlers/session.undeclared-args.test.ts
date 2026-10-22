/**
 * synap_update_session REFUSES an input it does not declare — it never reports
 * "updated" for a key it dropped.
 *
 * Live on the founder's pod: `reopenOutput: "spec"` (2026-10-22) and
 * `addOutputs` (2026-10-21, session 5382a350) each came back
 * `status: "updated"` while nothing changed; the real inputs are
 * `addOutput` / `outcomes`, and there is no reopen verb.
 *
 * Driven through the REAL handler with the DB spied to throw, so "refused
 * before any write" is asserted, not assumed. The valid set is the tool's
 * real declared schema (`tools.list()`), and a source scan pins the other
 * direction: every `args.<key>` the handler reads is declared, so the
 * refusal can never block an input the handler actually uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "../../../../../../scripts/strip-comments.mjs";
import { db } from "@synap/database";
import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";
import {
  declaredArgNames,
  undeclaredArgs,
  DOOR_INJECTED_ARGS,
} from "../undeclared-args.js";

const SID = "6fbc2b5c-e7dd-482f-b243-cd1dacabe020";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_update_session",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  };
}

function textOf(result: { content?: unknown[] }): string {
  return (result.content?.[0] as { text: string }).text;
}

describe("synap_update_session — an undeclared input is refused, nothing written", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    for (const m of ["select", "update", "insert", "transaction"] as const) {
      spies.push(
        vi.spyOn(db, m).mockImplementation(() => {
          throw new Error(`db.${m} must not run for a refused call`);
        })
      );
    }
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("refuses `reopenOutput` loudly, names it, lists the valid inputs", async () => {
    const result = await sessionHandlers.synap_update_session!(
      ctx({ sessionId: SID, reopenOutput: "spec" })
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("`reopenOutput`");
    expect(text).toContain("NOTHING WAS CHANGED");
    expect(text).toMatch(/Valid inputs: .*completeOutput/);
    expect(text).not.toMatch(/"status":\s*"updated"/);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("refuses `addOutputs` and points at the real input `addOutput`", async () => {
    const result = await sessionHandlers.synap_update_session!(
      ctx({
        sessionId: SID,
        addOutputs: [{ kind: "document", label: "Spec" }],
      })
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("did you mean `addOutput`");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("refuses the whole call even when a valid key rides along", async () => {
    // A partial apply would be the same lie: "updated", with half the patch gone.
    const result = await sessionHandlers.synap_update_session!(
      ctx({ sessionId: SID, progress: 50, reopenOutput: "spec" })
    );
    expect(result.isError).toBe(true);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("the valid set is the declared schema, and covers what the handler reads", () => {
  it("is read from the real tool list (non-vacuous)", async () => {
    const declared = await declaredArgNames("synap_update_session");
    expect(declared).not.toBeNull();
    expect(declared!.length).toBeGreaterThanOrEqual(15);
    for (const k of ["sessionId", "outcomes", "addOutput", "completeOutput"]) {
      expect(declared).toContain(k);
    }
    expect(declared).not.toContain("reopenOutput");
  });

  it("every declared key and every door-injected lens key passes", async () => {
    const declared = (await declaredArgNames("synap_update_session"))!;
    const all = Object.fromEntries(
      [...declared, ...DOOR_INJECTED_ARGS].map((k) => [k, 1])
    );
    expect(undeclaredArgs(all, declared)).toEqual([]);
  });

  it("every `args.<key>` the handler (and its slot parser) reads is declared", async () => {
    // Comment-stripped, so prose ("undeclared-args.ts") is never read as code.
    const src = stripComments(
      readFileSync(resolve(__dirname, "session.ts"), "utf8"),
      "ts"
    );
    const start = src.indexOf("synap_update_session: async");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const parserStart = src.indexOf("function parseSlotInputs(");
    expect(parserStart).toBeGreaterThan(0);
    const parser = src.slice(parserStart, src.indexOf("\n}\n", parserStart));
    const read = new Set(
      [...`${body}\n${parser}`.matchAll(/\bargs\.([A-Za-z_]+)/g)].map(
        (m) => m[1]!
      )
    );
    // Non-vacuity: the scan sees the inputs it must.
    for (const k of ["sessionId", "completeOutput", "addOutput", "outcomes"]) {
      expect(read).toContain(k);
    }
    const declared = (await declaredArgNames("synap_update_session"))!;
    const notDeclared = [...read].filter(
      (k) =>
        !declared.includes(k) &&
        !(DOOR_INJECTED_ARGS as readonly string[]).includes(k)
    );
    expect(notDeclared).toEqual([]);
  });
});
