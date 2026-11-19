import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTHORED_PREFIX,
  HOST_SEED_PREFIX,
  MACHINE_PREFIX,
  ORIGIN_KEYS,
  POSTURE_PREFIX,
  approvalAgentKey,
  approvalMatches,
  approvalOrigin,
  approvalSpaceKey,
  approvalTakeBack,
  approvalTitle,
  approvalToolKey,
  approvalToolName,
  filterValues,
  toolNamesOf,
  type ApprovalRowLike,
} from "./approvals-model";
import { en, fr } from "../../app/(admin)/approvals/_lib/copy";

const HREFS = {
  settings: "/settings/review",
  agent: (id: string) => `/agents/${id}`,
  proposal: (id: string) => `/proposal/${id}`,
  playbook: (id: string) => `/processes/${id}`,
};

function row(over: Partial<ApprovalRowLike> = {}): ApprovalRowLike {
  return {
    id: "r1",
    principalKind: "agent",
    agentUserId: "ag-1",
    agentLabel: "Claude",
    principalClass: null,
    scopeKind: "workspace",
    workspaceId: "ws-1",
    targetKind: "capability",
    targetPattern: "apify_linkedin_profile",
    targetProfile: null,
    verdict: "auto",
    sourceProposalId: null,
    createdBy: "user:person-1",
    ...over,
  };
}

/** One row per origin, each built the way its writer stamps it. */
const BY_ORIGIN: Record<(typeof ORIGIN_KEYS)[number], ApprovalRowLike> = {
  request: row({ sourceProposalId: "pr-1" }),
  playbook: row({
    targetKind: "action",
    targetPattern: "playbook.run",
    targetSubjectId: "pb-1",
  }),
  "pod-default": row({
    principalKind: "any",
    agentUserId: null,
    scopeKind: "pod",
    workspaceId: null,
    targetKind: "action",
    targetPattern: "@reversible",
    createdBy: "user:person-1",
  }),
  posture: row({ createdBy: "system:settings-mirror:person-1" }),
  computer: row({ createdBy: "system:host-seed:rule-9" }),
  "tool-page": row({
    principalKind: "any",
    agentUserId: null,
    scopeKind: "pod",
    workspaceId: null,
  }),
  person: row(),
  pod: row({ createdBy: "system:governance-backfill" }),
  unknown: row({ createdBy: "3f2a-legacy-uuid" }),
};

describe("approvalOrigin: where a row came from, from what it carries", () => {
  it("names every origin from a row stamped the way its writer stamps it", () => {
    for (const key of ORIGIN_KEYS) {
      expect(approvalOrigin(BY_ORIGIN[key], HREFS).key, key).toBe(key);
    }
  });

  it("is a door to the thing it came from, when that thing has a page", () => {
    expect(approvalOrigin(BY_ORIGIN.request, HREFS).href).toBe(
      "/proposal/pr-1"
    );
    expect(approvalOrigin(BY_ORIGIN.playbook, HREFS).href).toBe(
      "/processes/pb-1"
    );
    expect(approvalOrigin(BY_ORIGIN.posture, HREFS).href).toBe("/agents/ag-1");
    expect(approvalOrigin(BY_ORIGIN["pod-default"], HREFS).href).toBe(
      "/settings/review"
    );
  });

  it("never calls an unmarked author a person (fails toward 'unknown')", () => {
    expect(approvalOrigin(row({ createdBy: "" }), HREFS).key).toBe("unknown");
  });

  it("reads the author prefixes the pod actually stamps (@synap/database)", () => {
    const provenance = readFileSync(
      new URL(
        "../../../../packages/database/src/utils/governance-rule-provenance.ts",
        import.meta.url
      ),
      "utf8"
    );
    const hostSeed = readFileSync(
      new URL(
        "../../../../packages/database/src/utils/host-seed.ts",
        import.meta.url
      ),
      "utf8"
    );
    expect(provenance).toContain(
      `AUTHORED_CREATED_BY_PREFIX = "${AUTHORED_PREFIX}"`
    );
    expect(provenance).toContain(
      `SETTINGS_MIRROR_CREATED_BY_PREFIX = "${POSTURE_PREFIX}"`
    );
    expect(provenance).toContain(
      `MACHINE_CREATED_BY_PREFIX = "${MACHINE_PREFIX}"`
    );
    expect(hostSeed).toContain(
      "HOST_SEED_CREATED_BY_PREFIX = `${MACHINE_CREATED_BY_PREFIX}host-seed:`"
    );
    expect(HOST_SEED_PREFIX).toBe(`${MACHINE_PREFIX}host-seed:`);
  });
});

describe("approvalTakeBack: every row can be taken back, where it is set", () => {
  it("every origin has a way back (a revoke, the place it is set, or its source)", () => {
    for (const key of ORIGIN_KEYS) {
      const back = approvalTakeBack(BY_ORIGIN[key], HREFS);
      expect(["revoke", "elsewhere", "with-source"], key).toContain(back.kind);
    }
  });

  it("a pod default is changed by its switch, never revoked alone", () => {
    expect(approvalTakeBack(BY_ORIGIN["pod-default"], HREFS)).toEqual({
      kind: "elsewhere",
      href: "/settings/review",
      where: "settings",
    });
  });

  it("a posture row is changed on the agent's page, where the posture is chosen", () => {
    expect(approvalTakeBack(BY_ORIGIN.posture, HREFS)).toEqual({
      kind: "elsewhere",
      href: "/agents/ag-1",
      where: "agent",
    });
  });

  it("a computer's copy goes with the approval it copies", () => {
    expect(approvalTakeBack(BY_ORIGIN.computer, HREFS)).toEqual({
      kind: "with-source",
      ruleId: "rule-9",
    });
  });

  it("a request's answer, a pre-approval and a person's own row are revoked here", () => {
    for (const key of ["request", "playbook", "person", "tool-page"] as const)
      expect(approvalTakeBack(BY_ORIGIN[key], HREFS).kind, key).toBe("revoke");
  });
});

describe("the one filter row: agent, tool, verdict, space", () => {
  const rows = [
    row({ id: "a" }),
    row({
      id: "b",
      principalKind: "any",
      agentUserId: null,
      scopeKind: "pod",
      workspaceId: null,
      verdict: "deny",
    }),
    row({
      id: "c",
      principalKind: "class",
      agentUserId: null,
      principalClass: "machine",
      targetKind: "action",
      targetPattern: "entity.create",
      verdict: "propose",
    }),
  ];

  it("keys each row by who, which tool and where", () => {
    expect(rows.map(approvalAgentKey)).toEqual([
      "ag-1",
      "any",
      "class:machine",
    ]);
    expect(rows.map(approvalToolKey)).toEqual([
      "apify_linkedin_profile",
      "apify_linkedin_profile",
      null,
    ]);
    expect(rows.map(approvalSpaceKey)).toEqual(["ws-1", "pod", "ws-1"]);
  });

  it("narrows by every chip at once", () => {
    const pick = (f: Partial<Parameters<typeof approvalMatches>[1]>) =>
      rows
        .filter((r) =>
          approvalMatches(r, {
            agent: null,
            tool: null,
            verdict: null,
            space: null,
            ...f,
          })
        )
        .map((r) => r.id);
    expect(pick({})).toEqual(["a", "b", "c"]);
    expect(pick({ agent: "any" })).toEqual(["b"]);
    expect(pick({ tool: "apify_linkedin_profile" })).toEqual(["a", "b"]);
    expect(pick({ verdict: "propose" })).toEqual(["c"]);
    expect(pick({ space: "pod" })).toEqual(["b"]);
    expect(pick({ space: "ws-1", verdict: "auto" })).toEqual(["a"]);
  });

  it("takes each filter's values from the rows, counted", () => {
    expect(
      filterValues(rows, approvalToolKey).map((v) => [v.id, v.count])
    ).toEqual([["apify_linkedin_profile", 2]]);
  });
});

describe("the page's words", () => {
  it("names every origin, in both languages", () => {
    for (const key of ORIGIN_KEYS) {
      expect(en[`origin.${key}`], key).toBeTruthy();
      expect(fr[`origin.${key}`], key).toBeTruthy();
    }
  });
});

describe("a tool is named by its words, never its raw id", () => {
  const CARDS = [
    {
      id: "cap-apify",
      name: "Apify",
      verbs: [
        { verbId: "apify_linkedin_profile", label: "Read a LinkedIn profile" },
        { verbId: "capture_social_post", label: "Capture a social post" },
      ],
    },
  ];
  const toolName = toolNamesOf(CARDS);
  /** A raw verb id or snake_case token in a title. */
  const RAW = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;

  it("a tool rule's title is the catalog's label and its tool, with no raw id", () => {
    const title = approvalTitle(row(), { toolName });
    expect(title).toBe("Read a LinkedIn profile (Apify)");
    expect(title).not.toMatch(RAW);
  });

  it("a rule naming the capability itself reads its name", () => {
    expect(
      approvalTitle(row({ targetPattern: "cap-apify" }), { toolName })
    ).toBe("Apify");
  });

  it("an action the catalog does not hold still reads as words, never the id", () => {
    const name = approvalToolName("fr_company_lookup", toolNamesOf([]));
    expect(name).not.toMatch(RAW);
    expect(name).not.toContain("fr_company_lookup");
  });

  it("no capability row of the fixtures renders a raw id when a label exists", () => {
    for (const r of Object.values(BY_ORIGIN).filter(
      (r) => r.targetKind === "capability"
    )) {
      const title = approvalTitle(r, { toolName });
      expect(title, r.targetPattern).not.toMatch(RAW);
      expect(title, r.targetPattern).not.toContain(r.targetPattern);
    }
  });
});
