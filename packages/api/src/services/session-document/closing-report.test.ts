/**
 * The closing report's PURE half: the section builder, the "which sessions get
 * one" predicate, and the no-churn comparison — driven through the REAL
 * section splitter/serializer (`sections.ts`) and the real ownership refusal
 * (`renderDocumentPatch`, the patch door's pure half), so idempotency and "a person's section is never
 * rewritten" are proven on the same code the door runs.
 *
 * The golden body (`__fixtures__/closing-report.golden.md`) is ALSO read by
 * `@synap-core/markdown-core`'s `closing-report-contract.test.ts`, which parses
 * it with THE pipeline and the directive allowlist, and by its conformance
 * corpus (micromark ≡ scanner). Change the builder ⇒ regenerate the golden
 * FROM the builder (never by hand, never through prettier — `__fixtures__`
 * is prettier-ignored) ⇒ those tests re-check it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildClosingReportSections,
  closingReportApplies,
  sectionUnchanged,
  CLOSING_REPORT_SECTION_IDS,
  type ClosingReportInput,
} from "./closing-report.js";
import {
  parseSections,
  upsertSectionInMarkdown,
  sectionOwner,
} from "./sections.js";
import { renderDocumentPatch } from "../document-patch/patch-ops.js";

const GOLDEN = fileURLToPath(
  new URL("./__fixtures__/closing-report.golden.md", import.meta.url)
);

const FIXTURE: ClosingReportInput = {
  status: "closed",
  summary: "Shipped the relay theme toggle.\nTwo files changed.",
  criteria: [
    {
      key: "tsc",
      statement: "Typecheck passes",
      check: { kind: "evidence", evidenceKey: "tsc" },
    },
    { key: "copy", statement: "Copy | reads well", check: { kind: "judge" } },
    {
      key: "docs",
      statement: "Docs updated",
      required: false,
      check: { kind: "human" },
    },
  ],
  evaluations: [
    {
      criterionKey: "tsc",
      verdict: "pass",
      evaluatorKind: "evidence",
      evaluatorId: "agent-uuid",
      rationale: "0 errors",
    },
    {
      criterionKey: "copy",
      verdict: "fail",
      evaluatorKind: "judge",
      evaluatorId: "model-x",
      rationale: "Too long\nand vague",
    },
  ],
  verdict: {
    total: 3,
    passed: 1,
    failed: 1,
    unmeasured: 1,
    requiredUnmet: 1,
    state: "failing",
  },
  outputs: [
    { kind: "document", refId: "d-1", title: "Release  notes" },
    {
      kind: "entity",
      refId: "11111111-1111-4111-8111-111111111111",
      title: "Task A",
    },
    {
      kind: "entity",
      refId: "22222222-2222-4222-8222-222222222222",
      title: "Task B",
    },
  ],
  decisions: {
    total: 7,
    items: [
      { title: 'Create Task "Ship toggle"', status: "approved" },
      { title: 'Delete Note "Old"', status: "rejected" },
    ],
  },
};

/** Write the sections into `doc` exactly as the door would (agent-like writer). */
function applyAll(doc: string, input: ClosingReportInput): string {
  let out = doc;
  for (const s of buildClosingReportSections(input)) {
    out = renderDocumentPatch(
      out,
      [
        {
          op: "upsert_section",
          id: s.id,
          title: s.title,
          body: s.body,
          ...(s.status ? { status: s.status } : {}),
        },
      ],
      {
        writer: {
          isMachine: true,
          author: "system:closing-report",
          sessionState: "closed",
        },
        now: "2026-09-19T00:00:00.000Z",
      }
    ).markdown;
  }
  return out;
}

describe("buildClosingReportSections — structured, deterministic", () => {
  const sections = buildClosingReportSections(FIXTURE);

  it("four sections, stable ids, in reading order", () => {
    expect(sections.map((s) => s.id)).toEqual([
      CLOSING_REPORT_SECTION_IDS.outcome,
      CLOSING_REPORT_SECTION_IDS.definitionOfDone,
      CLOSING_REPORT_SECTION_IDS.produced,
      CLOSING_REPORT_SECTION_IDS.decisions,
    ]);
    expect(buildClosingReportSections(FIXTURE)).toEqual(sections);
  });

  it("matches the golden body the markdown-engine contract test parses", () => {
    expect(applyAll("", FIXTURE)).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  it("Outcome: status label + verdict line + the closing summary", () => {
    expect(sections[0]!.body).toContain(
      "**Closed** · 1 required criterion unmet (1 of 3 passed)"
    );
    expect(sections[0]!.body).toContain("Shipped the relay theme toggle.");
  });

  it("Definition of done: one table row per criterion; verdict state as status, never 'failed'", () => {
    const dod = sections[1]!;
    expect(dod.status).toBe("failing");
    const rows = dod.body
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
    expect(rows).toHaveLength(1 + FIXTURE.criteria.length);
    expect(dod.body).toContain(
      "| Typecheck passes | Passed | Evidence | 0 errors |"
    );
    // Pipes escaped, newlines flattened, judge names its model, uuids never shown.
    expect(dod.body).toContain(
      "| Copy \\| reads well | Failed | Judge (model-x) | Too long and vague |"
    );
    expect(dod.body).toContain(
      "| Docs updated (optional) | Not checked | — | — |"
    );
    expect(dod.body).not.toContain("agent-uuid");
    expect(dod.body).not.toContain("{");
  });

  it("no criteria ⇒ no status stamp and a plain sentence", () => {
    const none = buildClosingReportSections({
      ...FIXTURE,
      criteria: [],
      evaluations: [],
      verdict: {
        total: 0,
        passed: 0,
        failed: 0,
        unmeasured: 0,
        requiredUnmet: 0,
        state: "none",
      },
    });
    expect(none[1]!.status).toBeUndefined();
    expect(none[1]!.body).toBe("This session declared no criteria.");
  });

  it("What was produced: entities are reference-only synap-entity embeds", () => {
    const body = sections[2]!.body;
    expect(body).toContain("- Document: Release notes");
    expect(body).toContain(
      ':::synap-entity{id="11111111-1111-4111-8111-111111111111"}\n:::'
    );
    expect(body.match(/:::synap-entity/g)).toHaveLength(2);
    expect(body).not.toContain("Task A"); // the card reads the live entity
  });

  it("Decisions: count + the top items with their outcome label", () => {
    const body = sections[3]!.body;
    expect(body).toContain("7 proposals decided.");
    expect(body).toContain('- Create Task "Ship toggle" — Approved');
    expect(body).toContain('- Delete Note "Old" — Rejected');
    expect(body).toContain("- …and 5 more");
  });
});

describe("idempotent on re-close", () => {
  it("re-applying the same report is byte-identical and every section is unchanged", () => {
    const once = applyAll("# Notes\n\nMine.\n", FIXTURE);
    expect(applyAll(once, FIXTURE)).toBe(once);
    for (const s of buildClosingReportSections(FIXTURE)) {
      expect(sectionUnchanged(once, s)).toBe(true);
    }
    const parsed = parseSections(once);
    expect(parsed.duplicateIds).toEqual([]);
    expect(parsed.sections).toHaveLength(4);
  });

  it("a changed verdict rewrites the SAME section in place — never a second copy", () => {
    const once = applyAll("", FIXTURE);
    const regraded: ClosingReportInput = {
      ...FIXTURE,
      evaluations: FIXTURE.evaluations.map((e) =>
        e.criterionKey === "copy"
          ? { ...e, verdict: "pass", evaluatorKind: "human" }
          : e
      ),
      verdict: {
        total: 3,
        passed: 2,
        failed: 0,
        unmeasured: 1,
        requiredUnmet: 0,
        state: "passing",
      },
    };
    const dod = buildClosingReportSections(regraded)[1]!;
    expect(sectionUnchanged(once, dod)).toBe(false);
    const twice = applyAll(once, regraded);
    const parsed = parseSections(twice);
    expect(parsed.sections.map((s) => s.id)).toEqual(
      parseSections(once).sections.map((s) => s.id)
    );
    expect(parsed.sections[1]!.attributes.status).toBe("passing");
    expect(twice).toContain(
      "| Copy \\| reads well | Passed | Human | Too long and vague |"
    );
  });

  it("a status-only change is not 'unchanged'", () => {
    const once = applyAll("", FIXTURE);
    const dod = buildClosingReportSections(FIXTURE)[1]!;
    expect(sectionUnchanged(once, { ...dod, status: "passing" })).toBe(false);
  });
});

describe("a person's section is never rewritten", () => {
  it("the door refuses a machine write over a human-owned section of the same id", () => {
    const human = upsertSectionInMarkdown("", parseSections(""), {
      id: CLOSING_REPORT_SECTION_IDS.outcome,
      title: "My outcome",
      body: "In my words.",
      attributes: { owner: "human", author: "user-1" },
    }).markdown;
    expect(sectionOwner(parseSections(human).sections[0]!)).toBe("human");
    expect(() => applyAll(human, FIXTURE)).toThrow(/belongs to a person/);
  });
});

describe("closingReportApplies — who gets a report", () => {
  const counts = { criteria: 1, outputs: 0 };
  const work = {
    origin: "human",
    playbookId: null,
    metadata: {},
    status: "closed",
  };

  it("a person's work session with criteria or outputs: yes", () => {
    expect(closingReportApplies(work, counts)).toBe(true);
    expect(closingReportApplies(work, { criteria: 0, outputs: 2 })).toBe(true);
  });

  it("nothing structured to report: no", () => {
    expect(closingReportApplies(work, { criteria: 0, outputs: 0 })).toBe(false);
  });

  it("a receipt: never, even with outputs", () => {
    expect(
      closingReportApplies(
        {
          ...work,
          origin: "agent",
          metadata: { kind: "agent-proposal-package" },
        },
        { criteria: 3, outputs: 3 }
      )
    ).toBe(false);
  });

  it("an automation run and an intake run: never", () => {
    for (const metadata of [
      { automationId: "a" },
      { automationRunId: "r" },
      { intake: {} },
    ]) {
      expect(
        closingReportApplies(
          { ...work, origin: "automation", playbookId: "p", metadata },
          counts
        )
      ).toBe(false);
    }
  });

  it("a playbook run with criteria: yes", () => {
    expect(
      closingReportApplies(
        { ...work, origin: "playbook", playbookId: "p" },
        counts
      )
    ).toBe(true);
  });
});
