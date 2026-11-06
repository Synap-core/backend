/**
 * The facts ladder (`resolve-binding-rung.ts`, founder decisions d01–d03 of
 * 2026-11-05): which playbook a session follows, decided on FACTS only.
 *
 * Every row here is a REACHABILITY assertion on the decision the start and
 * update doors apply, and each `describe` names the rule it rules out.
 */
import { describe, it, expect } from "vitest";
import {
  BINDING_LINE_MAX,
  bindingLine,
  parseMainRedTitle,
  resolveBindingRung,
  type BindingPlaybook,
  type BindingSituation,
} from "../resolve-binding-rung.js";

const BUILDER = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const OTHER_SPACE = "9f93c23b-4774-48ec-83b0-aaa570f5441d";

let n = 0;
function pb(over: Partial<BindingPlaybook> = {}): BindingPlaybook {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Playbook ${n}`,
    status: "active",
    scope: "session",
    workspaceId: BUILDER,
    subjectProfile: null,
    inputStrategy: { kind: "none" },
    stages: [],
    params: [],
    ...over,
  };
}

const issue = (properties: Record<string, unknown> = {}) => ({
  kind: "issue",
  properties,
});

const at = (over: Partial<BindingSituation> = {}): BindingSituation => ({
  workspaceId: BUILDER,
  title: "Some work",
  subject: null,
  parent: null,
  ...over,
});

describe("rung 1: the caller named it", () => {
  it("binds the named playbook, whatever the other facts say", () => {
    const named = pb({ name: "Named" });
    const forIssue = pb({ subjectProfile: { profileSlug: "issue" } });
    const d = resolveBindingRung(
      at({ explicitPlaybookId: named.id, subject: issue() }),
      [named, forIssue]
    );
    expect(d).toMatchObject({
      kind: "bind",
      rung: "explicit",
      playbookId: named.id,
    });
  });
});

describe("rung 2: the subject's kind", () => {
  it("binds the ONE active playbook for that kind", () => {
    const fix = pb({
      name: "Fix a bug",
      subjectProfile: { profileSlug: "issue" },
    });
    const other = pb({ subjectProfile: { profileSlug: "task" } });
    const d = resolveBindingRung(at({ subject: issue() }), [fix, other]);
    expect(d).toMatchObject({
      kind: "bind",
      rung: "subject",
      playbookId: fix.id,
    });
  });

  it("two for the same kind in the same space: an offer, never a pick", () => {
    const a = pb({ subjectProfile: { profileSlug: "issue" } });
    const b = pb({ subjectProfile: { profileSlug: "issue" } });
    const d = resolveBindingRung(at({ subject: issue() }), [a, b]);
    expect(d.kind).toBe("offer");
    if (d.kind !== "offer") return;
    expect(d.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("the session's space is tried before pod-wide ones (one in-space wins over a pod-wide twin)", () => {
    const inSpace = pb({ subjectProfile: { profileSlug: "issue" } });
    const podWide = pb({
      workspaceId: null,
      subjectProfile: { profileSlug: "issue" },
    });
    const d = resolveBindingRung(at({ subject: issue() }), [podWide, inSpace]);
    expect(d).toMatchObject({ kind: "bind", playbookId: inSpace.id });
  });

  it("a pod-wide playbook binds when the space has none", () => {
    const podWide = pb({
      workspaceId: null,
      subjectProfile: { profileSlug: "issue" },
    });
    const d = resolveBindingRung(at({ subject: issue() }), [podWide]);
    expect(d).toMatchObject({ kind: "bind", playbookId: podWide.id });
  });

  it("a playbook of ANOTHER space never binds", () => {
    const elsewhere = pb({
      workspaceId: OTHER_SPACE,
      subjectProfile: { profileSlug: "issue" },
    });
    expect(resolveBindingRung(at({ subject: issue() }), [elsewhere])).toEqual({
      kind: "none",
    });
  });

  it("a project-scope playbook (a goal template) and a pinned one never bind", () => {
    const goalTemplate = pb({
      scope: "project",
      subjectProfile: { profileSlug: "issue" },
    });
    const pinned = pb({
      inputStrategy: { kind: "pinned", entityIds: [] },
      subjectProfile: { profileSlug: "issue" },
    });
    expect(
      resolveBindingRung(at({ subject: issue() }), [goalTemplate, pinned])
    ).toEqual({ kind: "none" });
  });

  it("a subject filter that fails (or cannot be read) rules the playbook out", () => {
    const urgentOnly = pb({
      subjectProfile: { profileSlug: "issue", filter: { priority: "urgent" } },
    });
    const any = pb({ subjectProfile: { profileSlug: "issue" } });
    const d = resolveBindingRung(at({ subject: issue({ priority: "low" }) }), [
      urgentOnly,
      any,
    ]);
    expect(d).toMatchObject({ kind: "bind", playbookId: any.id });
    const unreadable = pb({
      subjectProfile: { profileSlug: "issue", filter: "status = open" },
    });
    expect(resolveBindingRung(at({ subject: issue() }), [unreadable])).toEqual({
      kind: "none",
    });
  });

  it("a playbook whose stages follow the subject's status binds only while that status has a stage", () => {
    const fix = pb({
      subjectProfile: {
        profileSlug: "issue",
        statusProperty: "issueStatus",
        humanOnlyStatuses: ["wont_fix"],
      },
      stages: [
        { key: "reproduce", name: "Reproduce", subjectStatus: "open" },
        { key: "fix", name: "Fix", subjectStatus: "investigating" },
      ],
    });
    expect(
      resolveBindingRung(at({ subject: issue({ issueStatus: "open" }) }), [fix])
    ).toMatchObject({ kind: "bind", playbookId: fix.id });
    // A status no stage covers (already fixed) and a person-only one.
    for (const issueStatus of ["fixed", "wont_fix", undefined]) {
      expect(
        resolveBindingRung(at({ subject: issue({ issueStatus }) }), [fix])
      ).toEqual({ kind: "none" });
    }
  });

  it("no subject, or a subject whose kind no playbook runs on: no rung-2 bind", () => {
    const fix = pb({ subjectProfile: { profileSlug: "issue" } });
    expect(resolveBindingRung(at(), [fix])).toEqual({ kind: "none" });
    expect(
      resolveBindingRung(at({ subject: { kind: "note", properties: {} } }), [
        fix,
      ])
    ).toEqual({ kind: "none" });
  });
});

describe("only ACTIVE playbooks bind (a draft changes nothing until a person activates it)", () => {
  // The closed dev set (decision d05) as the dev-playbooks lane filed it:
  // drafts, session scope, in Builder.
  const devSet = (status: string) => [
    pb({ name: "Fix a bug", status, subjectProfile: { profileSlug: "issue" } }),
    pb({
      name: "Build a change",
      status,
      subjectProfile: { profileSlug: "devplane_feature" },
    }),
    pb({ name: "Investigate", status }),
    pb({ name: "Review a change", status }),
    pb({
      name: "Fix main red",
      status,
      params: [
        { name: "repo", type: "text", required: true },
        { name: "check", type: "text", required: true },
        { name: "sha8", type: "text", required: true },
      ],
    }),
    pb({ name: "Maintain", status }),
  ];
  const situations: BindingSituation[] = [
    at({ subject: issue() }),
    at({ subject: { kind: "devplane_feature", properties: {} } }),
    at({ title: "main red: backend Full suite @1a2b3c4d" }),
  ];

  it("as drafts (and paused, archived), the six bind nothing in any situation they are built for", () => {
    for (const status of ["draft", "paused", "archived"]) {
      const pool = devSet(status);
      for (const s of situations) {
        expect(resolveBindingRung(s, pool), `${status}`).toEqual({
          kind: "none",
        });
      }
    }
  });

  it("the same situations DO bind once the six are active (the rows above are not vacuous)", () => {
    const pool = devSet("active");
    expect(
      situations.map((s) => {
        const d = resolveBindingRung(s, pool);
        return d.kind === "bind"
          ? pool.find((p) => p.id === d.playbookId)?.name
          : d.kind;
      })
    ).toEqual(["Fix a bug", "Build a change", "Fix main red"]);
  });
});

describe("rung 3: the parent's playbook", () => {
  it("a lane inherits the playbook its parent follows", () => {
    const build = pb({ name: "Build a change" });
    const d = resolveBindingRung(
      at({
        parent: {
          id: "6307df89-24d4-424d-af42-a8598773c2e0",
          playbookId: build.id,
          currentStage: "build",
        },
      }),
      [build]
    );
    expect(d).toMatchObject({
      kind: "bind",
      rung: "parent",
      playbookId: build.id,
    });
    if (d.kind === "bind") expect(d.reason).toContain("6307df89");
  });

  it("only while the parent follows one, and only an active one", () => {
    const build = pb({ status: "archived" });
    expect(
      resolveBindingRung(
        at({ parent: { id: "p", playbookId: null, currentStage: null } }),
        [build]
      )
    ).toEqual({ kind: "none" });
    expect(
      resolveBindingRung(
        at({ parent: { id: "p", playbookId: build.id, currentStage: null } }),
        [build]
      )
    ).toEqual({ kind: "none" });
  });

  it("a parent playbook that runs on a subject the child does not have is not a bind", () => {
    const ship = pb({ subjectProfile: { profileSlug: "devplane_feature" } });
    expect(
      resolveBindingRung(
        at({ parent: { id: "p", playbookId: ship.id, currentStage: "build" } }),
        [ship]
      )
    ).toEqual({ kind: "none" });
  });

  it("when the subject offered several, the parent picks among them only", () => {
    const a = pb({ subjectProfile: { profileSlug: "issue" } });
    const b = pb({ subjectProfile: { profileSlug: "issue" } });
    const unrelated = pb();
    const pick = resolveBindingRung(
      at({
        subject: issue(),
        parent: { id: "p", playbookId: b.id, currentStage: null },
      }),
      [a, b, unrelated]
    );
    expect(pick).toMatchObject({
      kind: "bind",
      rung: "parent",
      playbookId: b.id,
    });
    const outside = resolveBindingRung(
      at({
        subject: issue(),
        parent: { id: "p", playbookId: unrelated.id, currentStage: null },
      }),
      [a, b, unrelated]
    );
    expect(outside.kind).toBe("offer");
  });
});

describe("rung 4: the `main red:` title (rules/github-ci)", () => {
  it("parses the grammar, check names with spaces included", () => {
    expect(parseMainRedTitle("main red: backend Full suite @1a2b3c4d")).toEqual(
      {
        repo: "backend",
        check: "Full suite",
        sha8: "1a2b3c4d",
      }
    );
    expect(parseMainRedTitle("Main red: backend")).toBe("prefix-only");
    expect(parseMainRedTitle("fix the main red build")).toBeNull();
  });

  it("binds the active main-red playbook and answers its declared params from the title", () => {
    const mainRed = pb({
      name: "Fix main red",
      params: [
        { name: "repo", type: "text", required: true },
        { name: "check", type: "text", required: true },
        { name: "sha8", type: "text", required: true },
      ],
    });
    const d = resolveBindingRung(
      at({ title: "main red: backend API e2e @deadbeef01" }),
      [mainRed, pb({ name: "Maintain" })]
    );
    expect(d).toMatchObject({
      kind: "bind",
      rung: "main-red",
      playbookId: mainRed.id,
      params: { repo: "backend", check: "API e2e", sha8: "deadbeef" },
    });
  });

  it("a title without the grammar binds with no params (the follow door owes them to the person)", () => {
    const mainRed = pb({
      name: "main-red",
      params: [{ name: "repo", type: "text", required: true }],
    });
    const d = resolveBindingRung(at({ title: "main red: something broke" }), [
      mainRed,
    ]);
    expect(d).toMatchObject({ kind: "bind", rung: "main-red" });
    if (d.kind === "bind") expect(d.params).toBeUndefined();
  });

  it("no active main-red playbook: none; two: an offer", () => {
    expect(
      resolveBindingRung(
        at({ title: "main red: backend Full suite @1a2b3c4d" }),
        [pb({ name: "Fix main red", status: "draft" })]
      )
    ).toEqual({ kind: "none" });
    expect(
      resolveBindingRung(
        at({ title: "main red: backend Full suite @1a2b3c4d" }),
        [pb({ name: "Fix main red" }), pb({ name: "Main-red triage" })]
      ).kind
    ).toBe("offer");
  });
});

describe("words never bind (d01) and nothing is a default (d03)", () => {
  it("a title naming a playbook word for word binds nothing", () => {
    const named = pb({ name: "Fix a bug" });
    const build = pb({ name: "Build a change" });
    expect(
      resolveBindingRung(at({ title: "Fix a bug" }), [named, build])
    ).toEqual({ kind: "none" });
    expect(
      resolveBindingRung(at({ title: "Build a change to the browser" }), [
        named,
        build,
      ])
    ).toEqual({ kind: "none" });
  });
});

describe("the reply line stays one lean line", () => {
  const ids = [0, 1, 2, 3].map(
    (i) => `00000000-0000-4000-8000-00000000000${i}`
  );
  const long = "A very long playbook name ".repeat(10);

  it("bound, offered, not bound: each under the bound, ids never clipped", () => {
    const lines = [
      bindingLine({
        kind: "bound",
        playbookId: ids[0]!,
        playbookName: long,
        reason: `the subject's kind is issue and "${long}" is the one active playbook for it`,
      }),
      bindingLine({
        kind: "offer",
        reason: `4 active playbooks run on kind issue; none was picked for you`,
        candidates: ids.map((id) => ({ id, name: long })),
      }),
      bindingLine({
        kind: "not_bound",
        playbookId: ids[0]!,
        playbookName: long,
        reason: long,
      }),
    ];
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(BINDING_LINE_MAX);
      expect(line).not.toContain("\n");
      expect(line).toContain(ids[0]!);
    }
    // At most three ids offered.
    expect(lines[1]).toContain(ids[2]!);
    expect(lines[1]).not.toContain(ids[3]!);
  });

  it("a short bound line keeps its reason", () => {
    expect(
      bindingLine({
        kind: "bound",
        playbookId: ids[0]!,
        playbookName: "Fix a bug",
        reason: "the subject's kind is issue",
      })
    ).toBe(
      `Follows "Fix a bug" (${ids[0]}): the subject's kind is issue. Release: update_session followPlaybookId: null.`
    );
  });
});
