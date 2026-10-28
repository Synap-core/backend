/**
 * `unblocks` — WHAT MOVES when the person answers (decision E, needs-truth
 * §5): declared by the agent with the hand-over, ADVISED when an agent hands
 * a slot to the person without it (rv-be-needs F1: the default line and a
 * warning, never a refusal), read from the cause for a system producer,
 * carried to every needs-you row, and advertised on every MCP slot schema.
 *
 * Each rule pairs the row that passes with its one-fact-away twin. Negative
 * control: without the rule (`slotsMissingUnblocks` returning []), the
 * "advised" rows carry no default and these go red.
 */
import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  ASK_UNBLOCKS_DEFAULT,
  effectiveSlotUnblocks,
} from "@synap-core/types/ask";
import { stampBlocked, stampUnblocked } from "../block-output.js";
import {
  slotsMissingUnblocks,
  unblocksAdvisedMessage,
  withDefaultUnblocks,
} from "../slot-asked-event.js";
import {
  addOutputWireSchema,
  applyOutputMutations,
} from "../update-session.js";
import { outcomeDeclarationSchema } from "../outcome-declarations.js";
import { projectOwedSlots } from "../owed-outputs.js";
import { signalFromOwedSlot } from "../../signals/needs-you-union.js";
import { tools } from "../../../routers/mcp/tools/index.js";

const AT = new Date("2026-10-27T09:00:00.000Z");
const AGENT_SLOT: ExpectedOutput = { kind: "decision", label: "Launch scope" };

describe("slotsMissingUnblocks — the agent rule", () => {
  it("advises a slot newly handed to the person with nothing it unblocks", () => {
    const after = applyOutputMutations([AGENT_SLOT], {
      addOutput: {
        kind: "decision",
        label: "Region",
        owner: "human",
        blockedReason: "decision",
        ask: { mode: "confirm" },
      },
    }).outputs;
    expect(slotsMissingUnblocks([AGENT_SLOT], after)).toEqual(["Region"]);
    // Landed with the default, said back — never "NOTHING WAS CHANGED".
    const advice = unblocksAdvisedMessage(["Region"]);
    expect(advice).toMatch(/"Region".*unblocks/);
    expect(advice).toContain(ASK_UNBLOCKS_DEFAULT);
    expect(advice).not.toMatch(/NOTHING WAS/);
  });

  it("the default goes on the named slot only, never over a declared line", () => {
    const [region, scope, said] = withDefaultUnblocks(
      [
        { label: "Region" },
        { label: "Launch scope" },
        { label: "Pricing", unblocks: "The pricing page" },
      ],
      ["region", "Pricing"]
    );
    expect(region!.unblocks).toBe(ASK_UNBLOCKS_DEFAULT);
    expect(scope!.unblocks).toBeUndefined();
    expect(said!.unblocks).toBe("The pricing page");
  });

  it("lets it land when it says what moves on the answer", () => {
    const after = applyOutputMutations([AGENT_SLOT], {
      addOutput: {
        kind: "decision",
        label: "Region",
        owner: "human",
        blockedReason: "decision",
        unblocks: "The EU launch deploy",
      },
    }).outputs;
    expect(slotsMissingUnblocks([AGENT_SLOT], after)).toEqual([]);
  });

  it("a system producer's cause says it; an agent-owned slot asks nothing", () => {
    const caused: ExpectedOutput = {
      ...AGENT_SLOT,
      owner: "human",
      owedSince: AT.toISOString(),
      askCause: { kind: "run" },
    };
    expect(slotsMissingUnblocks([AGENT_SLOT], [caused])).toEqual([]);
    expect(slotsMissingUnblocks([], [{ kind: "doc", label: "Draft" }])).toEqual(
      []
    );
  });

  it("a slot already owed, unchanged, is not posed again (legacy rows pass)", () => {
    const owed: ExpectedOutput = {
      ...AGENT_SLOT,
      owner: "human",
      owedSince: AT.toISOString(),
    };
    expect(slotsMissingUnblocks([owed], [owed])).toEqual([]);
    // …but re-asking it with a new ask poses it again.
    expect(
      slotsMissingUnblocks([owed], [{ ...owed, ask: { mode: "confirm" } }])
    ).toEqual(["Launch scope"]);
  });
});

describe("the block door stamps it; the hand-back clears it", () => {
  it("stampBlocked writes it, keeps a stored one, stampUnblocked clears it", () => {
    const [blocked] = stampBlocked(
      [AGENT_SLOT],
      "Launch scope",
      "decision",
      "EU or US?",
      AT,
      undefined,
      undefined,
      "The EU launch deploy"
    );
    expect(blocked!.unblocks).toBe("The EU launch deploy");
    const [reblocked] = stampBlocked([blocked!], "Launch scope", "decision");
    expect(reblocked!.unblocks).toBe("The EU launch deploy");
    const [back] = stampUnblocked([blocked!], "Launch scope");
    expect(back!.unblocks).toBeUndefined();
  });
});

describe("every slot door parses it", () => {
  it("addOutput and outcomes carry it; an empty line is refused", () => {
    expect(
      addOutputWireSchema.parse({ kind: "k", label: "l", unblocks: " x " })
        .unblocks
    ).toBe("x");
    expect(
      outcomeDeclarationSchema.parse({ label: "l", unblocks: "y" }).unblocks
    ).toBe("y");
    expect(
      addOutputWireSchema.safeParse({ kind: "k", label: "l", unblocks: "  " })
        .success
    ).toBe(false);
  });
});

describe("the read: owed slot → row", () => {
  it("projects the declared line, else the cause's, else nothing", () => {
    const base = {
      id: "s1",
      title: null,
      goal: "g",
      status: "active",
      workspaceId: null,
      projectId: null,
    };
    const [declared, caused, silent] = projectOwedSlots({
      ...base,
      expectedOutputs: [
        {
          ...AGENT_SLOT,
          label: "A",
          owner: "human",
          owedSince: AT.toISOString(),
          unblocks: "The deploy",
        },
        {
          ...AGENT_SLOT,
          label: "B",
          owner: "human",
          owedSince: AT.toISOString(),
          askCause: { kind: "gate" },
        },
        {
          ...AGENT_SLOT,
          label: "C",
          owner: "human",
          owedSince: AT.toISOString(),
        },
      ],
    });
    expect(declared!.unblocks).toBe("The deploy");
    expect(caused!.unblocks).toBe(
      effectiveSlotUnblocks({ label: "B", askCause: { kind: "gate" } })
    );
    expect(caused!.unblocks).toBeTruthy();
    expect(silent!.unblocks).toBeUndefined();
    expect(signalFromOwedSlot(declared!).unblocks).toBe("The deploy");
    expect("unblocks" in signalFromOwedSlot(silent!)).toBe(false);
  });
});

describe("mcp-slot-schema-parity: every advertised slot schema offers it", () => {
  it("start/update expectedOutputs, update addOutput and outcomes", async () => {
    const list = await tools.list();
    const props = (name: string, path: string[]) => {
      const tool = list.find((t) => t.name === name)!;
      let node: Record<string, unknown> = tool.inputSchema as never;
      for (const step of path) node = (node as never)[step] as never;
      return Object.keys(node);
    };
    const item = ["properties", "expectedOutputs", "items", "properties"];
    expect(props("synap_start_session", item)).toContain("unblocks");
    expect(props("synap_update_session", item)).toContain("unblocks");
    expect(
      props("synap_update_session", ["properties", "addOutput", "properties"])
    ).toContain("unblocks");
    expect(
      props("synap_update_session", [
        "properties",
        "outcomes",
        "items",
        "properties",
      ])
    ).toContain("unblocks");
  });
});
