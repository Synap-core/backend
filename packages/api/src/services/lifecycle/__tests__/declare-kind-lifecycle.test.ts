/**
 * The PURE half of the lifecycle-declaration door: what it refuses, what it
 * plans, and what the reviewer reads. The I/O half (propose → approve on a real
 * Postgres) is `declare-kind-lifecycle.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  decideKindLifecycleDeclaration,
  kindLifecycleReviewRows,
  kindLifecycleProposalTitle,
  type KindLifecycleFacts,
} from "../declare-kind-lifecycle.js";

const FINDING_OPTIONS = [
  { key: "open", category: "open", label: "Open" },
  { key: "fixing", category: "active", label: "Fixing" },
  { key: "fixed", category: "done", label: "Fixed" },
  { key: "verified", category: "done", label: "Verified" },
  { key: "wont_fix", category: "lost", label: "Won't fix" },
  { key: "superseded", category: "lost", label: "Superseded" },
];

function facts(over: Partial<KindLifecycleFacts> = {}): KindLifecycleFacts {
  return {
    profile: {
      id: "p-finding",
      slug: "finding",
      displayName: "Finding",
      profileKind: "kind",
      isActive: true,
      scope: "shared",
      workspaceId: "ws",
      userId: null,
    },
    property: "status",
    existingLifecycle: null,
    linked: [],
    unlinkedBase: null,
    storedValues: [],
    records: 296,
    ...over,
  };
}

describe("decideKindLifecycleDeclaration", () => {
  it("plans a NEW status field for a kind that has none", () => {
    const d = decideKindLifecycleDeclaration(facts(), {
      options: FINDING_OPTIONS,
      initialStatus: "open",
    });
    expect(d.verdict).toBe("declarable");
    if (d.verdict !== "declarable") return;
    expect(d.field).toEqual({ mode: "create" });
    expect(d.initialStatus).toBe("open");
    expect(d.options.map((o) => `${o.key}:${o.category}`)).toEqual([
      "open:open",
      "fixing:active",
      "fixed:done",
      "verified:done",
      "wont_fix:lost",
      "superseded:lost",
    ]);
    expect(d.options[4]!.label).toBe("Won't fix");
  });

  it("refuses an option whose category is not one of the five", () => {
    const d = decideKindLifecycleDeclaration(facts(), {
      options: [
        { key: "open", category: "open" },
        { key: "fixed", category: "resolved" },
      ],
    });
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    expect(d.reasons.join(" ")).toMatch(
      /"fixed" needs a category \(one of open, active, paused, done, lost\)/
    );
  });

  it("never replaces a lifecycle the kind already declares, and says which door changes it", () => {
    const d = decideKindLifecycleDeclaration(
      facts({
        existingLifecycle: {
          propertySlug: "status",
          options: ["todo", "done"],
        },
      }),
      { options: FINDING_OPTIONS }
    );
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    expect(d.reasons[0]).toMatch(/already declares "status"/);
    expect(d.reasons[0]).toMatch(/changeLifecycleOptions/);
  });

  it("refuses a GLOBAL field other kinds share", () => {
    const d = decideKindLifecycleDeclaration(
      facts({
        linked: [
          {
            id: "global-status",
            profileId: null,
            workspaceId: null,
            valueType: "string",
            storedKeys: ["todo", "done"],
          },
        ],
      }),
      { options: FINDING_OPTIONS }
    );
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    expect(d.reasons.join(" ")).toMatch(/GLOBAL field other kinds share/);
  });

  it("rewrites the kind's own base field, but never drops a key it already offers", () => {
    const own = {
      id: "own-status",
      profileId: "p-finding",
      workspaceId: null,
      valueType: "string",
      storedKeys: ["open", "closed"],
    };
    const dropped = decideKindLifecycleDeclaration(facts({ linked: [own] }), {
      options: FINDING_OPTIONS,
    });
    expect(dropped.verdict).toBe("refused");
    if (dropped.verdict === "refused") {
      expect(dropped.reasons.join(" ")).toMatch(/already offers "closed"/);
    }
    const kept = decideKindLifecycleDeclaration(facts({ linked: [own] }), {
      options: [...FINDING_OPTIONS, { key: "closed", category: "done" }],
    });
    expect(kept.verdict).toBe("declarable");
    if (kept.verdict === "declarable") {
      expect(kept.field).toEqual({
        mode: "rewrite",
        propertyDefId: "own-status",
      });
    }
  });

  it("refuses when records carry a value no option names", () => {
    const d = decideKindLifecycleDeclaration(
      facts({ storedValues: ["open", "triaged"] }),
      { options: FINDING_OPTIONS }
    );
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    expect(d.reasons.join(" ")).toMatch(/already carry "triaged"/);
    expect(d.reasons.join(" ")).not.toMatch(/"open"/);
  });

  it("refuses an initial status that is not an option, and date bindings", () => {
    const d = decideKindLifecycleDeclaration(facts(), {
      options: [
        { key: "open", category: "open", dateBinding: "dueDate" },
        { key: "fixed", category: "done" },
      ],
      initialStatus: "new",
    });
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    const all = d.reasons.join(" ");
    expect(all).toMatch(/initialStatus "new" is not one of the options/);
    expect(all).toMatch(/dateBinding and waits/);
  });

  it("refuses a retired kind and a field key that is not a slug", () => {
    const d = decideKindLifecycleDeclaration(
      facts({
        property: "Status!",
        profile: { ...facts().profile, isActive: false },
      }),
      { options: FINDING_OPTIONS }
    );
    expect(d.verdict).toBe("refused");
    if (d.verdict !== "refused") return;
    expect(d.reasons.join(" ")).toMatch(/is retired/);
    expect(d.reasons.join(" ")).toMatch(/is not a field key/);
  });
});

describe("the review display", () => {
  it("names the kind, every option with its category, and the initial status", () => {
    const f = facts();
    const d = decideKindLifecycleDeclaration(f, {
      options: FINDING_OPTIONS,
      initialStatus: "open",
    });
    if (d.verdict !== "declarable") throw new Error("expected declarable");
    const rows = kindLifecycleReviewRows(f, d);
    expect(rows.kind).toBe("Finding (finding)");
    expect(rows.field).toBe("status (a new field of this kind)");
    expect(rows.options).toBe(
      "open = Open (open) · fixing = Fixing (active) · fixed = Fixed (done) · " +
        "verified = Verified (done) · wont_fix = Won't fix (lost) · superseded = Superseded (lost)"
    );
    expect(rows.new_records_start_in).toBe("open");
    expect(rows.existing_records).toBe(296);
  });

  it("titles the proposal through the one title builder", () => {
    expect(kindLifecycleProposalTitle("finding")).toBe(
      'Declare lifecycle "finding"'
    );
  });
});
