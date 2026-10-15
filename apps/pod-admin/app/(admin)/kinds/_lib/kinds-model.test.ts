import { describe, expect, it } from "vitest";
import {
  kindPill,
  kindRows,
  recordsLine,
  retireOutcome,
  schemaFindings,
  scopeLabel,
  tidyItems,
  type DiagnoseSectionLike,
  type ProfileLike,
} from "./kinds-model";

const WS = new Map([
  ["w1", "Builder"],
  ["w2", "CRM"],
]);

const PROFILES: ProfileLike[] = [
  {
    id: "p-task",
    slug: "task",
    displayName: "Task",
    scope: "system",
    workspaceId: null,
  },
  {
    id: "p-proj-a",
    slug: "project",
    displayName: "Project",
    scope: "workspace",
    workspaceId: "w1",
  },
  {
    id: "p-proj-b",
    slug: "project",
    displayName: "Project",
    scope: "workspace",
    workspaceId: "w2",
  },
  {
    id: "p-empty",
    slug: "gizmo",
    displayName: "Gizmo",
    scope: "workspace",
    workspaceId: "w1",
  },
  {
    id: "p-shared-empty",
    slug: "widget",
    displayName: "Widget",
    scope: "shared",
    workspaceId: null,
  },
  {
    id: "p-client",
    slug: "client",
    displayName: "Client",
    scope: "system",
    workspaceId: null,
    profileKind: "role",
  },
];

const SECTIONS: DiagnoseSectionLike[] = [
  {
    key: "schema_hygiene",
    detail: {
      zeroEntityKinds: [
        { profileId: "p-empty", slug: "gizmo" },
        { profileId: "p-shared-empty", slug: "widget" },
        { slug: "no-id" },
      ],
    },
  },
  {
    key: "schema_contract",
    detail: {
      twins: [
        {
          slug: "project",
          rows: [{ profileId: "p-proj-a" }, { profileId: "p-proj-b" }],
        },
      ],
      reservedRows: [{ profileId: "p-task" }],
      undeclaredLinks: [{ profileSlug: "task", propertySlug: "legacy_due" }],
    },
  },
];

describe("schemaFindings", () => {
  it("reads both sections, skipping malformed entries", () => {
    const f = schemaFindings(SECTIONS);
    expect([...f.zeroRecordIds]).toEqual(["p-empty", "p-shared-empty"]);
    expect(f.twins.get("project")).toEqual(["p-proj-a", "p-proj-b"]);
    expect(f.reservedIds.has("p-task")).toBe(true);
    expect(f.undeclaredLinks).toEqual([
      { profileSlug: "task", propertySlug: "legacy_due" },
    ]);
    expect(f.known).toBe(true);
  });

  it("is empty and unknown before diagnose answers, and survives junk", () => {
    expect(schemaFindings(undefined).known).toBe(false);
    const junk = schemaFindings([
      { key: "schema_contract", detail: { twins: "nope", reservedRows: 3 } },
    ]);
    expect(junk.twins.size).toBe(0);
    expect(junk.reservedIds.size).toBe(0);
  });
});

describe("kindRows", () => {
  const f = schemaFindings(SECTIONS);
  const rows = kindRows(
    PROFILES,
    [
      { profileSlug: "task", count: 40 },
      { profileSlug: "project", count: 7 },
    ],
    f,
    WS
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  it("twins share their slug's count, and say so", () => {
    expect(byId.get("p-proj-a")!.records).toBe(7);
    expect(byId.get("p-proj-b")!.records).toBe(7);
    expect(recordsLine(byId.get("p-proj-a")!)).toBe(
      "7 records across 2 kinds named “project”"
    );
  });

  it("a slug with no count is zero; a role has no record count", () => {
    expect(byId.get("p-empty")!.records).toBe(0);
    expect(byId.get("p-client")!.records).toBeNull();
    expect(recordsLine(byId.get("p-client")!)).toBe("Role");
  });

  it("an unknown count stays unknown rather than zero", () => {
    const [row] = kindRows([PROFILES[0]!], null, f, WS);
    expect(row!.records).toBeNull();
    expect(recordsLine(row!)).toBe("—");
  });

  it("names the scope, and puts flagged kinds first", () => {
    expect(byId.get("p-proj-a")!.scope).toBe("Builder");
    expect(byId.get("p-shared-empty")!.scope).toBe("Shared");
    expect(rows.at(-1)!.pill).toBeNull();
    expect(rows[0]!.pill).not.toBeNull();
  });

  it("one pill, the most pressing first", () => {
    expect(kindPill("p-task", "task", f)).toEqual({
      kind: "down",
      label: "Reserved",
    });
    expect(kindPill("p-proj-a", "project", f)?.label).toBe("Duplicate slug");
    expect(kindPill("p-empty", "gizmo", f)?.label).toBe("No records");
    expect(kindPill("p-client", "client", f)).toBeNull();
  });

  it("scopeLabel covers personal and unnamed spaces", () => {
    expect(scopeLabel({ scope: "user", workspaceId: null }, WS)).toBe(
      "Personal"
    );
    expect(scopeLabel({ scope: "workspace", workspaceId: "zz" }, WS)).toBe(
      "A space"
    );
  });
});

describe("tidyItems", () => {
  const f = schemaFindings(SECTIONS);
  const items = tidyItems(kindRows(PROFILES, [], f, WS), f);

  it("offers Retire only for a space kind, in its own space", () => {
    const gizmo = items.find((i) => i.key === "zero:p-empty")!;
    expect(gizmo.action).toEqual({
      kind: "retire",
      profileId: "p-empty",
      workspaceId: "w1",
    });
    // A shared kind has no space to file in — the app, never a guessed one.
    expect(items.find((i) => i.key === "zero:p-shared-empty")!.action).toEqual({
      kind: "app",
    });
  });

  it("explains twins and undeclared links, each with one way on", () => {
    const twin = items.find((i) => i.key === "twin:project")!;
    expect(twin.sentence).toContain(
      "2 kinds are named “project” (Builder, CRM)"
    );
    expect(twin.action.kind).toBe("app");
    expect(twin.focusId).toBe("p-proj-a");
    const link = items.find((i) => i.key === "link:task:legacy_due")!;
    expect(link.title).toBe("Task");
    expect(link.focusId).toBe("p-task");
  });
});

describe("retireOutcome", () => {
  it("says where it went", () => {
    expect(retireOutcome({ status: "proposed", proposalId: "x" })).toEqual({
      message: "Sent to Review.",
      proposalId: "x",
    });
    expect(
      retireOutcome({ status: "already_pending", proposalId: "y" }).message
    ).toBe("Already waiting in Review.");
    expect(retireOutcome({ status: "already_retired" }).proposalId).toBeNull();
  });

  it("a refusal says why, and names the merge it filed instead", () => {
    expect(
      retireOutcome({
        status: "refused",
        reasons: ["3 records still use it."],
        mergeProposalId: "m1",
        noMergeReason: null,
      })
    ).toEqual({
      message: "3 records still use it. A merge was sent to Review instead.",
      proposalId: "m1",
    });
    expect(
      retireOutcome({
        status: "refused",
        reasons: [],
        mergeProposalId: null,
        noMergeReason: "Only a pod admin can merge kinds.",
      }).message
    ).toBe("Only a pod admin can merge kinds.");
  });
});
