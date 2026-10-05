/**
 * Lens rows from the REAL wire shapes of the 2026-10-05 dogfood on the
 * founder's pod (`.claude/work/DOGFOOD-lens.md`, home.png / home-2.png /
 * home-3.png). Each fixture is a signal as `signals.list({ lens: "page" })`
 * sent it; each assertion is the defect that was on screen.
 */
import { describe, expect, it } from "vitest";
import { resolveUnitState } from "../units/state.js";
import { activityObjectTitle, resolveActivityVerb } from "../activity/index.js";
import {
  buildObjectActionTitle,
  resolveActionLabel,
} from "../vocabulary/index.js";
import {
  FAILURE_NOTIFICATION_TYPES,
  lensItemsOfClass,
  type LensNeedsYouSignal,
} from "./index.js";

const base = {
  groupKey: null,
  ageBucket: "older" as const,
  repeatCount: 1,
  count: 1,
};

/** "meta encountered an error" — `agent.task_failed`, folded 9× by the pod. */
const metaFailed: LensNeedsYouSignal = {
  ...base,
  id: "notification:n-9",
  kind: "notification",
  title: "meta encountered an error",
  category: "ai",
  notificationType: "agent.task_failed",
  target: { kind: "run", id: "run-9" },
  occurredAt: "2026-09-14T10:00:00.000Z",
  count: 9,
  repeatCount: 9,
};

/** An agent draft as `signalsFromDraftAsks` titles it. */
const draft: LensNeedsYouSignal = {
  ...base,
  id: "draft:s-dog",
  kind: "draft-asks",
  title:
    "Claude-code started Dogfood Connect & Mirror after deploy and plan the next waves · asks you 9 things",
  category: "ai",
  sessionGoal: "Dogfood Connect & Mirror after deploy and plan the next waves",
  sessionTitle: "Dogfood Connect & Mirror after deploy",
  groupKey: "session:s-dog",
  target: { kind: "session", id: "s-dog" },
  occurredAt: "2026-09-14T10:00:00.000Z",
  count: 9,
};

describe("an agent FAILURE notification (P1)", () => {
  it("is a Blocking row with the failed mark, an Open verb, ×9, and never 'Asked by AI'", () => {
    const [item] = lensItemsOfClass([metaFailed], "blocking");
    const row = item!.row;
    expect(resolveUnitState(row.state).state).toBe("failed");
    expect(row.verb).toEqual({ action: "open", label: "Open" });
    expect(row.door).toEqual({ kind: "run", id: "run-9" });
    expect(row.repeat).toBe("×9");
    expect(row.byAgent).toBe(false);
  });

  it("an agent's real ASK (an ai-category notification that is not a failure) keeps the mark", () => {
    const [item] = lensItemsOfClass(
      [
        {
          ...metaFailed,
          notificationType: "session.criterion_escalated",
          repeatCount: 1,
          count: 1,
        },
      ],
      "blocking"
    );
    expect(item!.row.byAgent).toBe(true);
    expect(item!.row.verb).toBeNull();
  });

  it("the failure set is non-empty and holds the type the pod raised", () => {
    expect(FAILURE_NOTIFICATION_TYPES.has("agent.task_failed")).toBe(true);
  });
});

describe("a Proposed draft row (P2: state words agree with the mark)", () => {
  it("names the work, never 'started' beside a Not-started mark; the chip counts the asks", () => {
    const [item] = lensItemsOfClass([draft], "proposed");
    const row = item!.row;
    expect(resolveUnitState(row.state).state).toBe("not_started");
    expect(row.title).toBe("Dogfood Connect & Mirror after deploy");
    expect(row.title).not.toMatch(/started/i);
    expect(row.reason).toBe("9 asks");
  });
});

describe("Happened / Needs-you words through the vocabulary door (P2)", () => {
  it("a graph write proposal never leaks the token 'Graph' as a verb", () => {
    expect(resolveActionLabel("capture.graph", "imperative")).toBe("Capture");
    expect(resolveActivityVerb("capture.graph")).toBe("Captured");
    expect(resolveActivityVerb("import.graph")).toBe("Imported");
    expect(
      buildObjectActionTitle({
        action: "capture.graph",
        objectName: "101 new and 5 matching records",
      })
    ).toBe('Capture "101 new and 5 matching records"');
  });

  it("a headline that already leads with the act's verb is not doubled", () => {
    const title = 'Create Markdown "Plan — Point at anything"';
    expect(
      `${resolveActivityVerb("create")} ${activityObjectTitle("create", title)}`
    ).toBe('Created Markdown "Plan — Point at anything"');
    expect(
      activityObjectTitle("capture.graph", "Captured: DECISION 2026-10-05")
    ).toBe("DECISION 2026-10-05");
  });

  it("leaves a title whose first word is another verb, or a prefix, whole", () => {
    expect(activityObjectTitle("create", "Plan the UI refactor")).toBe(
      "Plan the UI refactor"
    );
    expect(activityObjectTitle("create", "Creates a link")).toBe(
      "Creates a link"
    );
    expect(activityObjectTitle("create", "Create")).toBe("Create");
  });
});
