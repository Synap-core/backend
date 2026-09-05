/**
 * Rules-ecosystem "THEN" menu — the PLAYBOOK-RUN tier.
 *
 * A `playbook_run` THEN spawns a session running a playbook. The node has been
 * executable since the playbook wave (`automation-executor.ts` →
 * `executePlaybookRun`), but `availableActions` never offered it, so the lane had
 * zero producers. These are PURE-LOGIC tests over the projection helper — no
 * Postgres: the DB read that feeds it (`scopedDb.findMany(playbooks)`) yields the
 * rows supplied directly here, and its VISIBILITY floor is the access registry's
 * `playbooks` rule, tested with the access layer.
 */
import { describe, expect, it } from "vitest";
import { playbookActionOptions } from "./automations.js";

const PB = "44444444-4444-4444-4444-444444444444";

describe("playbookActionOptions (playbooks → playbook_run THEN options)", () => {
  it("keys on playbook:<id> and carries the id the node needs", () => {
    const [opt, ...rest] = playbookActionOptions([
      { id: PB, name: "Weekly digest", params: [] },
    ]);
    expect(rest).toHaveLength(0);
    expect(opt).toEqual({
      key: `playbook:${PB}`,
      label: "Weekly digest",
      nodeType: "playbook_run",
      playbookId: PB,
      params: [],
    });
  });

  it("projects declared params into the shared activate-gate shape", () => {
    const [opt] = playbookActionOptions([
      {
        id: PB,
        name: "Research",
        params: [
          { name: "topic", type: "text", required: true },
          // An authored label wins; otherwise the ONE humanization door.
          { name: "max_sources", type: "number", label: "How many sources" },
        ],
      },
    ]);
    // ⚠️ This asserted `{key,label,required}` exactly, with fixtures that
    // declare `type: "text"` and `type: "number"` — so it pinned the DROP as
    // correct, the second test in this repo to do so. `PlaybookParam.type` is
    // REQUIRED in the authoring contract, and playbook params are the only ones
    // that carry `boolean` and `choice`; a client reading this projection had
    // no way to render either.
    expect(opt.params).toEqual([
      { key: "topic", label: "Topic", required: true, type: "string" },
      {
        key: "max_sources",
        label: "How many sources",
        required: false,
        type: "number",
      },
    ]);
  });

  it("maps choice to an enum with its options, and boolean through", () => {
    const [opt] = playbookActionOptions([
      {
        id: PB,
        name: "P",
        params: [
          { name: "tone", type: "choice", options: ["brief", "full"] },
          { name: "dry_run", type: "boolean" },
        ],
      },
    ]);
    expect(opt.params).toEqual([
      {
        key: "tone",
        label: "Tone",
        required: false,
        type: "enum",
        options: ["brief", "full"],
      },
      { key: "dry_run", label: "Dry run", required: false, type: "boolean" },
    ]);
  });

  it("omits `entity` rather than declaring a type with no control", () => {
    // There is no entity picker in the param renderer. A declared type the
    // client cannot render is worse than an honest text box.
    const [opt] = playbookActionOptions([
      { id: PB, name: "P", params: [{ name: "who", type: "entity" }] },
    ]);
    expect(opt.params).toEqual([{ key: "who", label: "Who", required: false }]);
  });

  it("drops malformed param entries instead of offering a nameless field", () => {
    const [opt] = playbookActionOptions([
      {
        id: PB,
        name: "P",
        params: [null, "nope", { label: "no name" }, { name: "ok" }],
      },
    ]);
    expect(opt.params).toEqual([{ key: "ok", label: "Ok", required: false }]);
  });

  it("tolerates a non-array params jsonb (hand-edited row) as no params", () => {
    expect(
      playbookActionOptions([{ id: PB, name: "P", params: {} }])[0].params
    ).toEqual([]);
    expect(playbookActionOptions([{ id: PB, name: "P" }])[0].params).toEqual(
      []
    );
  });
});
