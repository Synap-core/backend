import { describe, it, expect } from "vitest";
import {
  pickPlaybookNameMatch,
  resolvePlaybookRunWriteWorkspace,
  toPlaybookNameCandidate,
} from "./resolve-playbook-name.js";
import type { Playbook } from "@synap/database/schema";

function pb(partial: Pick<Playbook, "id" | "name" | "workspaceId">): Playbook {
  return partial as Playbook;
}

describe("pickPlaybookNameMatch", () => {
  it("returns not_found for an empty set", () => {
    expect(pickPlaybookNameMatch([])).toEqual({ status: "not_found" });
  });

  it("returns the single match (workspace-scoped)", () => {
    const row = pb({
      id: "pb-1",
      name: "CRM Hygiene",
      workspaceId: "ws-crm",
    });
    expect(pickPlaybookNameMatch([row])).toEqual({
      status: "found",
      playbook: row,
    });
  });

  it("returns the single match (pod-wide NULL)", () => {
    const row = pb({
      id: "pb-pod",
      name: "Weekly digest",
      workspaceId: null,
    });
    expect(pickPlaybookNameMatch([row])).toEqual({
      status: "found",
      playbook: row,
    });
  });

  it("returns multi-match candidates (never silent pick)", () => {
    const a = pb({ id: "pb-a", name: "Hygiene", workspaceId: "ws-crm" });
    const b = pb({ id: "pb-b", name: "Hygiene", workspaceId: "ws-sales" });
    const result = pickPlaybookNameMatch([a, b]);
    expect(result).toEqual({
      status: "ambiguous",
      candidates: [
        { id: "pb-a", name: "Hygiene", workspaceId: "ws-crm" },
        { id: "pb-b", name: "Hygiene", workspaceId: "ws-sales" },
      ],
    });
  });
});

describe("toPlaybookNameCandidate", () => {
  it("projects id/name/workspaceId only", () => {
    expect(
      toPlaybookNameCandidate(pb({ id: "x", name: "N", workspaceId: null }))
    ).toEqual({ id: "x", name: "N", workspaceId: null });
  });
});

describe("resolvePlaybookRunWriteWorkspace", () => {
  const CRM = "ws-crm";
  const SALES = "ws-sales";

  it("prefers explicit workspace over playbook home", () => {
    expect(
      resolvePlaybookRunWriteWorkspace({
        explicitWorkspaceId: SALES,
        playbookWorkspaceId: CRM,
      })
    ).toBe(SALES);
  });

  it("uses playbook.workspaceId when no explicit lens", () => {
    expect(
      resolvePlaybookRunWriteWorkspace({
        explicitWorkspaceId: null,
        playbookWorkspaceId: CRM,
      })
    ).toBe(CRM);
  });

  it("falls through to subject, then session, for pod-wide playbooks", () => {
    expect(
      resolvePlaybookRunWriteWorkspace({
        explicitWorkspaceId: undefined,
        playbookWorkspaceId: null,
        subjectWorkspaceId: CRM,
        sessionWorkspaceId: SALES,
      })
    ).toBe(CRM);

    expect(
      resolvePlaybookRunWriteWorkspace({
        playbookWorkspaceId: null,
        subjectWorkspaceId: null,
        sessionWorkspaceId: SALES,
      })
    ).toBe(SALES);
  });

  it("returns null when no write home (pod-wide + no subject/session)", () => {
    expect(
      resolvePlaybookRunWriteWorkspace({
        playbookWorkspaceId: null,
      })
    ).toBeNull();
  });

  it("treats empty string as unset (never a write home)", () => {
    expect(
      resolvePlaybookRunWriteWorkspace({
        explicitWorkspaceId: "  ",
        playbookWorkspaceId: CRM,
      })
    ).toBe(CRM);
  });
});
