/**
 * TRIPWIRE — an agent-facing write door's description names the outcomes its
 * handler can actually return.
 *
 * WHY: for a narrow door (Raycast, the claude.ai connector) the description IS
 * the product — it is the only thing the acting model reads before it decides
 * whether a result was a success. Two live dogfood failures, 2026-09-14/09-20:
 *   • `synap_run_playbook` said only "returns proposed". It also returns
 *     `status:"blocked"` with `enableProposals[]` when the playbook needs a
 *     skill pack that is not enabled. An agent that has never heard of
 *     "blocked" reports a false success, or retries a call that will block
 *     again until a human approves the enable request.
 *   • `synap_create_cell` / `synap_create_playbook` never said an agent call
 *     is always a proposal, so the Control Plane appended that sentence itself
 *     (`synap-control-plane-api/src/routes/mcp-pod-tools.ts`) — a SECOND copy
 *     of the rule, one repo away from the source it describes.
 *
 * WHAT IT PINS: the CONTRACT (which outcomes are named), never the wording.
 * Both sets are DERIVED — the door set from `tools.list()`, the status set from
 * the router source — so a new door or a new outcome joins the scan by
 * existing, not by anyone remembering this file.
 *
 * WHAT IT DOES NOT COVER, measured: the status scan is derived for
 * `playbooks.run` only. Every OTHER handler's outcome set is still unchecked —
 * deriving it generally would mean tracing each handler through its door to its
 * router procedure, which no parse here does. Test 1 is the general (weaker)
 * floor: a create/define door must mention proposals AT ALL; it cannot tell a
 * correct sentence from a wrong one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_SRC = resolve(__dirname, "../../playbooks.ts");

describe("tripwire: write-door descriptions name their real outcomes", () => {
  it("every create/define write door says the call may land as a proposal", async () => {
    const live = await tools.list();
    expect(
      live.length,
      "tools.list() returned nothing — every assertion below would be vacuous"
    ).toBeGreaterThan(20);

    // DERIVED from the tool name + the readOnly annotation, so a newly added
    // `synap_create_*` / `synap_define_*` door joins this scan by existing.
    const doors = live.filter(
      (t) =>
        /^synap_(create|define)_/.test(t.name) &&
        t.annotations?.readOnlyHint !== true
    );
    expect(
      doors.length,
      "the create/define door scan matched (almost) nothing — the naming " +
        "convention or the annotation shape changed, and this test is now blind"
    ).toBeGreaterThanOrEqual(10);

    // Self-check: the scan can still see what it hunts for in a real door.
    expect(
      doors.some((t) => /propos/i.test(t.description ?? "")),
      "no door mentions proposals at all — the descriptions moved somewhere " +
        "this scan cannot read"
    ).toBe(true);

    const silent = doors
      .filter((t) => !/propos/i.test(t.description ?? ""))
      .map((t) => t.name);
    expect(
      silent,
      `These agent-facing write doors never say the write may land as a ` +
        `proposal: ${silent.join(", ")}. An agent reads \`proposed\` as a ` +
        `failure and retries. Say it in the pod description — not in a ` +
        `narrow door's own copy of the rule.`
    ).toEqual([]);
  });

  it("synap_run_playbook names every status `playbooks.run` can return", async () => {
    const src = readFileSync(PLAYBOOKS_SRC, "utf8");

    // Slice the `run` procedure out of the router: from its own declaration to
    // the next top-level procedure. Derived, so a fourth outcome added inside
    // `run` is picked up without touching this file.
    const start = src.search(/^ {2}run: \w+Procedure/m);
    expect(
      start,
      "could not find the `run:` procedure in playbooks.ts — the router shape " +
        "changed and this scan is reading nothing"
    ).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const nextAt = rest.search(/^ {2}\w+: \w+Procedure/m);
    const body = nextAt === -1 ? rest : rest.slice(0, nextAt);
    expect(
      body.length,
      "the sliced `run` procedure body is implausibly short"
    ).toBeGreaterThan(500);

    const statuses = [
      ...new Set(
        [...body.matchAll(/\bstatus:\s*"([a-z_]+)"\s+as const/g)].map(
          (m) => m[1]!
        )
      ),
    ];
    expect(
      statuses.length,
      "found fewer than 2 returned statuses in `playbooks.run` — the return " +
        "shape changed (e.g. the literals are no longer `as const`), so the " +
        "comparison below would pass over nothing"
    ).toBeGreaterThanOrEqual(2);

    const tool = (await tools.list()).find(
      (t) => t.name === "synap_run_playbook"
    );
    expect(tool, "synap_run_playbook is gone from the tool set").toBeTruthy();
    const description = tool!.description ?? "";

    const unnamed = statuses.filter((s) => !description.includes(s));
    expect(
      unnamed,
      `\`playbooks.run\` can return status ${unnamed
        .map((s) => `"${s}"`)
        .join(", ")}, and synap_run_playbook's description never names ` +
        `it. An agent that has not been told an outcome exists reports a ` +
        `false success or retries. Statuses found in source: ` +
        `${statuses.join(", ")}.`
    ).toEqual([]);
  });
});
