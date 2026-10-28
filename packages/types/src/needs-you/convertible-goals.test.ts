/**
 * The "Make them goals" card's title (founder decision D-3, 2026-10-26): said
 * once, by the pod, for every surface — how many, of which retired kinds,
 * from where.
 */
import { describe, expect, it } from "vitest";
import { convertibleGoalsTitle, type NeedsYouConvertibleGoal } from "./index";

const e = (
  kind: NeedsYouConvertibleGoal["kind"],
  spaceName: string | null = "Life OS"
): NeedsYouConvertibleGoal => ({
  entityId: `${kind}-${Math.random()}`,
  title: "x",
  kind,
  spaceName,
  projectIds: [],
});

describe("convertibleGoalsTitle", () => {
  it("one kind from one space", () => {
    expect(
      convertibleGoalsTitle({
        entities: [e("goal"), e("goal"), e("goal")],
        truncated: false,
      })
    ).toBe("3 goals from Life OS can become goals");
    expect(
      convertibleGoalsTitle({
        entities: [e("objective", "Enterprise OS")],
        truncated: false,
      })
    ).toBe("1 objective from Enterprise OS can become goals");
  });

  it("several kinds and spaces are each named; an acronym keeps its casing", () => {
    expect(
      convertibleGoalsTitle({
        entities: [
          e("goal"),
          e("goal"),
          e("objective", "Enterprise OS"),
          e("okr", "Enterprise OS"),
        ],
        truncated: false,
      })
    ).toBe(
      "2 goals, 1 objective and 1 OKR from Life OS and Enterprise OS can become goals"
    );
  });

  it("past two spaces they are counted; no space is not invented", () => {
    expect(
      convertibleGoalsTitle({
        entities: [e("goal", "A"), e("goal", "B"), e("goal", "C")],
        truncated: false,
      })
    ).toBe("3 goals from 3 spaces can become goals");
    expect(
      convertibleGoalsTitle({
        entities: [e("okr", null), e("okr", null)],
        truncated: false,
      })
    ).toBe("2 OKRs can become goals");
  });

  it("a capped scan is a floor, never an exact number", () => {
    expect(
      convertibleGoalsTitle({
        entities: [e("goal"), e("objective")],
        truncated: true,
      })
    ).toBe("2+ goals and objectives from Life OS can become goals");
  });
});
