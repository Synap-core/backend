/**
 * What a proposal still needs from you (finding 91a3bfd3): the block that
 * keeps Approve waiting (B5), the rows to hand over with how to get each
 * (B3), and the one entry each row may send (B1/B2: a saved key or a new
 * one for a secret, a value for anything else).
 */
import { describe, expect, it } from "vitest";
import {
  proposalSetupBlock,
  setupEntry,
  setupRows,
} from "./proposal-setup-model";
import type { ProposalSetup } from "../../_lib/request/api";

const setup = {
  blocking: true,
  params: [
    {
      name: "region",
      required: false,
      secret: false,
      satisfied: false,
    },
    {
      name: "apiKey",
      label: "Cal.com API key",
      required: true,
      secret: true,
      satisfied: false,
      obtain: {
        url: "https://app.cal.com/settings/developer/api-keys",
        steps: ["Open Settings, then Developer", "Create a key", " "],
      },
    },
    { name: "team", required: true, secret: false, satisfied: true },
  ],
} satisfies ProposalSetup;

describe("proposalSetupBlock — Approve waits on the first required row (B5)", () => {
  it("names it by its label", () => {
    expect(proposalSetupBlock(setup)).toEqual({
      kind: "fill",
      name: "Cal.com API key",
    });
  });
  it("a required connection not connected holds Approve, with the pod's own next step", () => {
    expect(
      proposalSetupBlock({
        blocking: true,
        params: [],
        connection: {
          required: true,
          kind: "provider",
          provider: "google",
          state: "missing",
        },
        nextAction: {
          kind: "connect",
          hint: "Connect your Google account",
          url: "/apps/google",
        },
      } as ProposalSetup)
    ).toEqual({
      kind: "connect",
      hint: "Connect your Google account",
      url: "/apps/google",
    });
  });
  it("a connection link the console cannot open as is is never offered", () => {
    const block = proposalSetupBlock({
      blocking: true,
      params: [],
      connection: { required: true, kind: "provider", state: "missing" },
      nextAction: {
        kind: "connect",
        hint: "Connect it",
        url: "synap://open/app/settings",
      },
    } as ProposalSetup);
    expect(block).toMatchObject({ kind: "connect", url: null });
  });
  it("a need nobody can tell still blocks, said as such — never 'nothing needed'", () => {
    expect(
      proposalSetupBlock({ blocking: true, params: [], unreadable: true })
    ).toEqual({ kind: "unreadable" });
  });
  it("nothing blocks: Approve does not wait", () => {
    expect(proposalSetupBlock({ ...setup, blocking: false })).toBeNull();
    expect(proposalSetupBlock(undefined)).toBeNull();
  });
});

describe("setupRows — what is left to hand over, required first", () => {
  it("drops what is filled, puts required first, keeps the steps and an https page", () => {
    const rows = setupRows(setup);
    expect(rows.map((r) => r.name)).toEqual(["apiKey", "region"]);
    expect(rows[0]).toMatchObject({
      label: "Cal.com API key",
      secret: true,
      obtain: {
        url: "https://app.cal.com/settings/developer/api-keys",
        steps: ["Open Settings, then Developer", "Create a key"],
      },
    });
    // No label: the name humanized, never the raw token.
    expect(rows[1]!.label).toBe("Region");
    expect(rows[1]!.obtain).toBeNull();
  });
  it("a page that is not https is never offered", () => {
    const rows = setupRows({
      params: [
        {
          name: "k",
          required: true,
          secret: true,
          satisfied: false,
          obtain: { url: "javascript:alert(1)", steps: [] },
        },
      ],
    });
    expect(rows[0]!.obtain).toBeNull();
  });
});

describe("setupEntry — the one entry a row may send", () => {
  const secret = { secret: true };
  const plain = { secret: false };
  it("a secret row: a saved key (a vault ref) or a new key, never a plain value", () => {
    expect(setupEntry(secret, { kind: "existing", ref: "vault://s1" })).toEqual(
      { kind: "existing", ref: "vault://s1" }
    );
    expect(setupEntry(secret, { kind: "new", value: " sk_123 " })).toEqual({
      kind: "new",
      value: "sk_123",
    });
    expect(setupEntry(secret, { kind: "value", value: "sk_123" })).toBeNull();
    expect(setupEntry(secret, { kind: "existing", ref: "s1" })).toBeNull();
  });
  it("a plain row: a value; nothing typed sends nothing", () => {
    expect(setupEntry(plain, { kind: "value", value: "eu" })).toEqual({
      kind: "value",
      value: "eu",
    });
    expect(setupEntry(plain, { kind: "value", value: "  " })).toBeNull();
    expect(setupEntry(plain, { kind: "new", value: "x" })).toBeNull();
    expect(setupEntry(plain, null)).toBeNull();
  });
});
