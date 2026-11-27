/**
 * TRIPWIRE — the surfaces choice-rule eval can still grade what it claims.
 *
 * `skills/surfaces/eval/run.mjs` is run on demand (it calls a model), so CI
 * never runs it. What CI can hold is its input and its grader: the prompt set
 * (its prompts and its adversarial ones) parses with the eval's own parser,
 * every item is complete, and every door an item accepts is a door agents
 * really have (a tool in the committed MCP manifest, or `none`). A door that
 * does not exist could never be answered, so the item would be graded
 * against nothing.
 *
 * WHAT IT CANNOT SEE: whether a model passes (that is the eval itself), or
 * whether an accepted body is the RIGHT one (the audit's table is the source).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(HERE, "../../../../skills/surfaces/eval");
const MANIFEST = resolve(HERE, "../routers/mcp/tools/mcp-tools.manifest.json");

interface Item {
  id: string;
  prompt: string;
  expectBody: string[];
  expectDoor: string[];
  attached?: boolean;
  why: string;
}

const run = (await import(
  pathToFileURL(resolve(EVAL_DIR, "run.mjs")).href
)) as {
  parsePrompts: (text: string) => Record<string, Item[]>;
  grade: (item: Item, answer: Record<string, unknown>) => string[];
};

describe("tripwire: the surfaces eval's prompts and grader", () => {
  const sets = run.parsePrompts(
    readFileSync(resolve(EVAL_DIR, "prompts.yaml"), "utf8")
  );

  it("holds prompts and adversarial ones, each complete", () => {
    expect(sets.prompts?.length).toBeGreaterThan(0);
    expect(sets.adversarial?.length).toBeGreaterThan(0);
    for (const item of [...sets.prompts!, ...sets.adversarial!]) {
      expect(item.prompt.length, item.id).toBeGreaterThan(5);
      expect(item.why.length, item.id).toBeGreaterThan(5);
      expect(item.expectBody.length, item.id).toBeGreaterThan(0);
      expect(item.expectDoor.length, item.id).toBeGreaterThan(0);
    }
  });

  it("every accepted door is a real MCP tool (or none)", () => {
    const tools = new Set(
      (
        JSON.parse(readFileSync(MANIFEST, "utf8")) as {
          tools: Array<{ name: string }>;
        }
      ).tools.map((t) => t.name)
    );
    expect(tools.has("synap_create_surface")).toBe(true);
    const unknown = [...sets.prompts!, ...sets.adversarial!].flatMap((item) =>
      item.expectDoor
        .filter((door) => door !== "none" && !tools.has(door))
        .map((door) => `${item.id}: ${door}`)
    );
    expect(unknown).toEqual([]);
  });

  it("the grader passes the expected answer and fails a wrong body, door or anchor", () => {
    const radar = sets.adversarial!.find((i) => i.attached)!;
    expect(radar).toBeTruthy();
    const right = {
      body: radar.expectBody[0],
      door: radar.expectDoor[0],
      attachedTo: "project",
    };
    expect(run.grade(radar, right)).toEqual([]);
    expect(run.grade(radar, { ...right, body: "renderer" })).not.toEqual([]);
    expect(
      run.grade(radar, { ...right, door: "synap_promote_cell_to_renderer" })
    ).not.toEqual([]);
    expect(run.grade(radar, { ...right, attachedTo: null })).not.toEqual([]);
  });
});
