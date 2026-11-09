/**
 * The person's passkeys from Kratos' settings flow (W5): one row per
 * `passkey_remove` node, and why one may not be removed (Kratos' own last
 * sign-in, or the last passkey while approvals need you in person).
 */
import { describe, expect, it } from "vitest";
import type { KratosFlow, KratosUiNode } from "../../../lib/kratos-flow";
import { passkeyRemoveBlock, passkeyRows } from "./passkeys-model";

const removeNode = (
  id: string,
  over: { disabled?: boolean; context?: Record<string, unknown> } = {}
): KratosUiNode => ({
  type: "input",
  group: "passkey",
  attributes: {
    name: "passkey_remove",
    type: "submit",
    value: id,
    disabled: over.disabled ?? false,
  },
  meta: {
    label: {
      id: 1050019,
      text: `Remove passkey "ada@example.com"`,
      context: over.context ?? {
        display_name: "ada@example.com",
        added_at: "2026-11-03T10:00:00Z",
        added_at_unix: 1793700000,
      },
    },
  },
});

const flow = (nodes: KratosUiNode[]): KratosFlow =>
  ({
    id: "f1",
    ui: {
      action: "https://pod/self-service/settings?flow=f1",
      method: "POST",
      nodes: [
        { type: "input", group: "default", attributes: { name: "csrf_token" } },
        {
          type: "input",
          group: "passkey",
          attributes: { name: "passkey_create_data", value: "{}" },
        },
        ...nodes,
      ],
    },
  }) as unknown as KratosFlow;

describe("passkeyRows", () => {
  it("one row per remove button: its id, name and when it was added", () => {
    const rows = passkeyRows(flow([removeNode("a1"), removeNode("b2")]));
    expect(rows).toEqual([
      {
        id: "a1",
        name: "ada@example.com",
        addedAt: "2026-11-03T10:00:00Z",
        onlySignIn: false,
      },
      {
        id: "b2",
        name: "ada@example.com",
        addedAt: "2026-11-03T10:00:00Z",
        onlySignIn: false,
      },
    ]);
  });

  it("no passkey: no rows (the create node is not one)", () => {
    expect(passkeyRows(flow([]))).toEqual([]);
  });

  it("a missing name or date is null, never a raw value; Kratos' disabled = only sign-in", () => {
    const [row] = passkeyRows(
      flow([
        removeNode("c3", {
          disabled: true,
          context: { display_name: " ", added_at: "not a date" },
        }),
      ])
    );
    expect(row).toEqual({
      id: "c3",
      name: null,
      addedAt: null,
      onlySignIn: true,
    });
  });
});

describe("passkeyRemoveBlock", () => {
  const row = {
    id: "a1",
    name: null,
    addedAt: null,
    onlySignIn: false,
  };

  it("the last passkey while approvals need you in person is kept", () => {
    expect(passkeyRemoveBlock({ row, passkeys: 1, mode: "enforce" })).toBe(
      "lastWithProof"
    );
  });

  it("recording only: the last passkey may go (Kratos still guards sign-in)", () => {
    expect(passkeyRemoveBlock({ row, passkeys: 1, mode: "report" })).toBe(null);
  });

  it("an unread mode never offers the last passkey on a guess", () => {
    expect(passkeyRemoveBlock({ row, passkeys: 1, mode: null })).toBe(
      "unknownMode"
    );
  });

  it("with another passkey, either may go, whatever the mode", () => {
    expect(passkeyRemoveBlock({ row, passkeys: 2, mode: "enforce" })).toBe(
      null
    );
    expect(passkeyRemoveBlock({ row, passkeys: 2, mode: null })).toBe(null);
  });

  it("Kratos' only way to sign in comes first", () => {
    expect(
      passkeyRemoveBlock({
        row: { ...row, onlySignIn: true },
        passkeys: 2,
        mode: "report",
      })
    ).toBe("onlySignIn");
  });
});
