/**
 * `bornLifecycleFor` — the lifecycle of a row being CREATED.
 *
 * WHY: `finding` declared `initialStatus: open` on 3 Nov (synap_declare_lifecycle),
 * yet three findings captured minutes later were born with NO status: a link
 * default reaches a row only through property validation, which applies it to a
 * REQUIRED property, and a lifecycle field is optional. Each case below is one
 * branch of the rule: fill a non-terminal, non-person-only initial status when
 * the creator names none; never override a named one; never fill a terminal or
 * human-only one (that birth stays the create gate's to govern).
 */
import { describe, it, expect } from "vitest";
import { bornLifecycleFor } from "../lifecycle-columns.js";
import type { EffectiveLifecycle } from "../../../utils/lifecycle-model.js";

function lifecycle(initialStatus: string | null): EffectiveLifecycle {
  return {
    propertySlug: "status",
    propertyDefId: "def-1",
    declaredOnProfileId: "p-1",
    unclassified: [],
    initialStatus,
    options: [
      { key: "open", category: "open" },
      { key: "fixing", category: "active" },
      { key: "fixed", category: "done" },
      { key: "wont_fix", category: "lost" },
      { key: "triage", category: "open", humanOnly: true },
    ],
  } as EffectiveLifecycle;
}

function resolver(l: EffectiveLifecycle | null) {
  return { getEffectiveLifecycle: async () => l } as never;
}

describe("bornLifecycleFor", () => {
  it("a create that names no status starts in the initial status, bag and columns", async () => {
    const out = await bornLifecycleFor(
      resolver(lifecycle("open")),
      "p-1",
      null,
      {
        severity: "high",
      }
    );
    expect(out?.properties).toEqual({ severity: "high", status: "open" });
    expect(out?.columns).toEqual({
      propertySlug: "status",
      status: "open",
      statusCategory: "open",
    });
  });

  it("an empty status counts as none named", async () => {
    const out = await bornLifecycleFor(
      resolver(lifecycle("open")),
      "p-1",
      null,
      {
        status: "",
      }
    );
    expect(out?.columns.status).toBe("open");
  });

  it("a status the creator names wins over the initial status", async () => {
    const out = await bornLifecycleFor(
      resolver(lifecycle("open")),
      "p-1",
      null,
      {
        status: "fixing",
      }
    );
    expect(out?.properties).toEqual({ status: "fixing" });
    expect(out?.columns.statusCategory).toBe("active");
  });

  it("a terminal initial status is not filled in: that birth stays governed", async () => {
    for (const initial of ["fixed", "wont_fix"]) {
      const out = await bornLifecycleFor(
        resolver(lifecycle(initial)),
        "p-1",
        null,
        {}
      );
      expect(out?.properties).toEqual({});
      expect(out?.columns.status).toBeNull();
    }
  });

  it("a human-only initial status is not filled in", async () => {
    const out = await bornLifecycleFor(
      resolver(lifecycle("triage")),
      "p-1",
      null,
      {}
    );
    expect(out?.columns.status).toBeNull();
  });

  it("no initial status declared: the row keeps none", async () => {
    const out = await bornLifecycleFor(
      resolver(lifecycle(null)),
      "p-1",
      null,
      {}
    );
    expect(out?.properties).toEqual({});
    expect(out?.columns.status).toBeNull();
  });

  it("a kind with no lifecycle, or no profile, has no born lifecycle", async () => {
    expect(await bornLifecycleFor(resolver(null), "p-1", null, {})).toBeNull();
    expect(
      await bornLifecycleFor(resolver(lifecycle("open")), null, null, {})
    ).toBeNull();
  });
});
