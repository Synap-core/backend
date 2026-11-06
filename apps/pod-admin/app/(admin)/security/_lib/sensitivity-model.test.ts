/**
 * "What asks for your passkey" (W5): the rows are the pod's own lists,
 * grouped by reason (deploys first), named through the vocabulary door, and
 * a switch changes exactly one row of the choice.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import {
  SENSITIVE_ACTIONS,
  SENSITIVE_APPROVALS,
  SENSITIVE_PROPOSAL_TYPE_PREFIXES,
} from "@synap-core/types/presence";
import {
  REASON_ORDER,
  SENSITIVITY_CAP,
  sensitivityView,
  withRow,
} from "./sensitivity-model";

setAmbientCatalogLocale("en");

const LISTED =
  Object.keys(SENSITIVE_APPROVALS).length +
  Object.keys(SENSITIVE_PROPOSAL_TYPE_PREFIXES).length +
  Object.keys(SENSITIVE_ACTIONS).length;

describe("sensitivityView", () => {
  it("default: every row of the pod's lists, each asking", () => {
    const v = sensitivityView(null, { expanded: new Set(REASON_ORDER) });
    expect(v.total).toBe(LISTED);
    expect(v.asking).toBe(LISTED);
    expect(v.anyOff).toBe(false);
    const shown = v.groups.flatMap((g) => g.rows);
    expect(shown).toHaveLength(LISTED);
    expect(shown.every((r) => r.on)).toBe(true);
  });

  it("deploys come first, and the deploy approval is a row of its own", () => {
    const v = sensitivityView(null);
    expect(v.groups[0]!.reason).toBe("deploy");
    expect(v.groups[0]!.rows.map((r) => r.key)).toContain(
      "focus_session/dev.deploy_approval"
    );
  });

  it("a switched-off row is off, counted, and nothing else moves", () => {
    const v = sensitivityView({
      approvalsOff: ["focus_session/dev.deploy_approval"],
      actionsOff: [],
    });
    const deploy = v.groups.find((g) => g.reason === "deploy")!;
    expect(deploy.asking).toBe(deploy.total - 1);
    expect(v.asking).toBe(LISTED - 1);
    expect(v.anyOff).toBe(true);
  });

  it("every label is words, never a raw token or an empty string", () => {
    const v = sensitivityView(null, { expanded: new Set(REASON_ORDER) });
    for (const r of v.groups.flatMap((g) => g.rows)) {
      expect(r.label.trim()).not.toBe("");
      expect(r.label).not.toBe(r.key);
      expect(r.label).not.toMatch(/[/_]/);
    }
  });

  it("a type prefix is marked, so the card says 'Any … request'", () => {
    const v = sensitivityView(null, { expanded: new Set(REASON_ORDER) });
    const prefix = v.groups.flatMap((g) => g.rows).find((r) => r.prefix);
    expect(prefix).toMatchObject({ key: "governance.", label: "Governance" });
  });

  it("a group lists its first rows until Show all", () => {
    const v = sensitivityView(null);
    for (const g of v.groups) {
      expect(g.rows.length).toBe(Math.min(g.total, SENSITIVITY_CAP));
      expect(g.more).toBe(g.total - g.rows.length);
    }
  });

  it("approvals come before actions inside a group", () => {
    const v = sensitivityView(null, { expanded: new Set(REASON_ORDER) });
    for (const g of v.groups) {
      const kinds = g.rows.map((r) => r.kind);
      const firstAction = kinds.indexOf("action");
      if (firstAction >= 0)
        expect(kinds.slice(firstAction).every((k) => k === "action")).toBe(
          true
        );
    }
  });
});

describe("withRow", () => {
  it("switches exactly one row off, then back on", () => {
    const off = withRow(null, { kind: "action", key: "apiKeys.create" }, false);
    expect(off).toEqual({ approvalsOff: [], actionsOff: ["apiKeys.create"] });
    expect(
      withRow(off, { kind: "action", key: "apiKeys.create" }, true)
    ).toEqual({ approvalsOff: [], actionsOff: [] });
  });

  it("keeps what was already off, sorted, once", () => {
    const next = withRow(
      { approvalsOff: ["workspace/delete"], actionsOff: [] },
      { kind: "approval", key: "entity/delete" },
      false
    );
    expect(next.approvalsOff).toEqual(["entity/delete", "workspace/delete"]);
  });
});
