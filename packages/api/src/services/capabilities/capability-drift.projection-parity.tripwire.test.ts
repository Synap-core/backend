/**
 * The comparator must read EVERY field the applier projects.
 *
 * `reconcileCapabilitiesToTemplates` converges an installed capability to its
 * Control-Plane template by diffing the two and, when they match, stamping the
 * template's `contentHash` — after which the fast path skips the container
 * entirely. So a field the comparator cannot see is not merely "missed once":
 * the reconcile records that it converged, and never looks again. That is
 * exactly how `ToolVerbCatalogEntry.intent` shipped to the Control Plane, synced
 * into every pod's catalog cache, and reached ZERO pods — the four-field
 * comparator never read it, and every pod stamped itself up to date.
 *
 * This is a CLASS defect, not an intent defect: it recurs for any field added to
 * the capability-definition skill shape. These tests pin both projection
 * surfaces — the live `skills` row and the requiring tool's verb catalog — to
 * the applier's own code, so adding a field without teaching the comparator
 * fails HERE, by name, instead of silently never propagating.
 *
 * Pinned + counted on purpose (same idiom as
 * `capability-template-intent-coverage.test.ts`): an assertion that merely says
 * "some drift was found" passes vacuously the day the field set is widened.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";

import {
  PROJECTED_SKILL_FIELDS,
  DRIFT_COMPARATOR_VERSION,
  projectSkillMetadata,
  declaredAllowedHosts,
  canonicalJson,
  capabilityDefinitionDrift,
  capabilityVerbCatalogDrift,
  capabilityToolMergeDrift,
  mergePreservingExisting,
  PROJECTED_TOOL_MERGE_FIELDS,
  type DefinitionSkillRow,
  type InstalledSkillRow,
} from "./capability-drift.js";
import { deriveToolVerbs } from "./create-from-definition.js";

const here = dirname(fileURLToPath(import.meta.url));

const WHY_IT_MATTERS =
  "A field the applier projects but the comparator does not read can NEVER reach " +
  "an already-installed pod: reconcile reports no drift, stamps the template's " +
  "contentHash anyway, and fast-paths past the container forever. Add the field " +
  "to PROJECTED_SKILL_FIELDS (capability-drift.ts), add its column to BOTH " +
  "`skills` selects (reconcile-capabilities-to-templates.ts and " +
  "ensure-synap-core.ts), and bump DRIFT_COMPARATOR_VERSION so already-stamped " +
  "containers are re-diffed once.";

/**
 * The definition-owned keys the applier writes onto an existing `skills` row —
 * read out of its own `.set({...})` rather than re-listed here, so the pin can
 * never quietly disagree with the code it is pinning. A key whose value
 * expression does not mention the definition skill (`s.`) is DB-owned state
 * (`updatedAt`, `approved`) and is not a projection.
 */
function applierProjectedSkillKeys(): string[] {
  const src = readFileSync(join(here, "create-from-definition.ts"), "utf8");
  const start = src.indexOf(".update(skillsTable)");
  expect(start, "applier's skills update block not found").toBeGreaterThan(-1);
  const setStart = src.indexOf(".set({", start);
  const end = src.indexOf(
    ".where(eq(skillsTable.id, existingSkill.id))",
    setStart
  );
  expect(
    end,
    "end of the applier's skills update block not found"
  ).toBeGreaterThan(setStart);
  const keys: string[] = [];
  for (const line of src.slice(setStart, end).split("\n")) {
    const m = /^\s+(\w+):\s*(.+)$/.exec(line);
    if (m && /\bs\./.test(m[2])) keys.push(m[1]);
  }
  return keys;
}

describe("drift comparator ↔ applier projection parity (skills row)", () => {
  it("reads EXACTLY the fields the applier projects — no more, no fewer", () => {
    const applied = applierProjectedSkillKeys().sort();
    // Guard against a vacuous pass: if the extraction stops matching, both
    // sides go empty and every assertion below succeeds on nothing.
    expect(
      applied.length,
      "extracted no projected keys from the applier — the extraction is broken, " +
        "not the code under test"
    ).toBeGreaterThanOrEqual(11);
    const compared = Object.keys(PROJECTED_SKILL_FIELDS).sort();
    const unread = applied.filter((k) => !compared.includes(k));
    expect(
      unread,
      `the applier projects ${JSON.stringify(unread)} but the drift comparator never reads it. ${WHY_IT_MATTERS}`
    ).toEqual([]);
    expect(
      compared.filter((k) => !applied.includes(k)),
      "the comparator reads a field the applier no longer projects — it can " +
        "report drift a re-apply will never converge, i.e. a re-apply every boot"
    ).toEqual([]);
  });

  it("pins the field COUNT so widening the set is a deliberate edit", () => {
    expect(
      Object.keys(PROJECTED_SKILL_FIELDS).length,
      "the projected-field set changed. " + WHY_IT_MATTERS
    ).toBe(11);
    expect(
      DRIFT_COMPARATOR_VERSION,
      "DRIFT_COMPARATOR_VERSION must be bumped (and this pin updated) whenever " +
        "the comparator's coverage changes — otherwise every container already " +
        "stamped by the OLD comparator keeps its stamp and is never re-diffed."
    ).toBe(5);
  });

  /** A value pair per field: what the template declares vs what the live row has. */
  const PERTURBATIONS: Record<
    string,
    { def: Partial<DefinitionSkillRow>; live: Partial<InstalledSkillRow> }
  > = {
    providerSpec: {
      def: { providerSpec: { path: "/v2" } },
      live: { providerSpec: { path: "/v1" } },
    },
    parameters: { def: { parameters: { to: {} } }, live: { parameters: {} } },
    code: { def: { code: "return 2;" }, live: { code: "return 1;" } },
    description: { def: { description: "new" }, live: { description: "old" } },
    kind: { def: { kind: "declarative" }, live: { kind: "code" } },
    scope: { def: { scope: "workspace" }, live: { scope: "pod" } },
    category: { def: { category: "enrichment" }, live: { category: null } },
    agentTypes: { def: { agentTypes: ["meta"] }, live: { agentTypes: null } },
    executionMode: {
      def: { executionMode: "async" },
      live: { executionMode: "sync" },
    },
    timeoutSeconds: {
      def: { timeoutSeconds: 60 },
      live: { timeoutSeconds: 30 },
    },
    // The applier writes exactly ONE key of this bag (`projectSkillMetadata`),
    // so the perturbation is on that key — a `marketSource` difference is DB
    // state and must NOT be drift (asserted separately below).
    metadata: {
      def: { metadata: { allowedHosts: ["api.vendor.com"] } },
      live: { metadata: { allowedHosts: [] } },
    },
  };

  const BASE = {
    name: "send_message",
    providerSpec: { path: "/v1" },
    parameters: {},
    code: "return 1;",
    description: "old",
    kind: "code",
    scope: "pod",
    category: null,
    agentTypes: null,
    executionMode: "sync",
    timeoutSeconds: 30,
    metadata: { allowedHosts: [] },
  } as const;

  it("every pinned field is LIVE — a change to it alone is reported as drift", () => {
    for (const field of Object.keys(PROJECTED_SKILL_FIELDS)) {
      const p = PERTURBATIONS[field];
      expect(p, `no perturbation pinned for "${field}"`).toBeTruthy();
      const installed: InstalledSkillRow[] = [{ ...BASE, ...p.live }];
      const def = { skills: [{ ...BASE, ...p.def } as DefinitionSkillRow] };
      expect(
        capabilityDefinitionDrift(installed, def).drifted,
        `a template change touching ONLY "${field}" is invisible to the comparator. ${WHY_IT_MATTERS}`
      ).toEqual(["send_message"]);
    }
  });

  it("an identical row is not drift (the perturbations, not the base, do the work)", () => {
    expect(
      capabilityDefinitionDrift([{ ...BASE }], {
        skills: [{ ...BASE } as DefinitionSkillRow],
      }).drifted
    ).toEqual([]);
  });

  // The `metadata` entry is NARROWED to one key, so it needs its own pins: the
  // comparator must be blind to DB-owned keys (else every boot re-applies), and
  // the applier's projection must in fact write only that key (else the marker
  // asserts a convergence nobody checked — the durable-lie shape).
  describe("metadata is narrowed to the egress declaration, honestly", () => {
    it("a DB-owned metadata key is not drift", () => {
      const live: InstalledSkillRow = {
        ...BASE,
        metadata: {
          allowedHosts: [],
          marketSource: { slug: "x", baseline: { code: "1" } },
          runCount: 7,
        },
      };
      expect(
        capabilityDefinitionDrift([live], {
          skills: [{ ...BASE } as DefinitionSkillRow],
        }).drifted
      ).toEqual([]);
    });

    it("a definition that declares NO hosts leaves a live list alone (skip, not revoke)", () => {
      const live: InstalledSkillRow = {
        ...BASE,
        metadata: { allowedHosts: ["api.vendor.com"] },
      };
      const def = { ...BASE, metadata: {} } as DefinitionSkillRow;
      expect(
        capabilityDefinitionDrift([live], { skills: [def] }).drifted
      ).toEqual([]);
      expect(projectSkillMetadata(live.metadata, def.metadata)).toBeUndefined();
    });

    it("the applier's projection writes ONLY allowedHosts, preserving the rest", () => {
      const existing = {
        allowedHosts: ["old.example.com"],
        marketSource: { slug: "x" },
        runCount: 7,
      };
      const next = projectSkillMetadata(existing, {
        allowedHosts: ["api.vendor.com"],
        verbType: "ignored",
      });
      expect(next).toEqual({
        allowedHosts: ["api.vendor.com"],
        marketSource: { slug: "x" },
        runCount: 7,
      });
      // Every key the comparator does NOT read is byte-identical.
      for (const k of Object.keys(existing)) {
        if (k === "allowedHosts") continue;
        expect(canonicalJson(next?.[k])).toBe(
          canonicalJson(existing[k as keyof typeof existing])
        );
      }
    });

    it("a non-array declaration is ignored, never persisted", () => {
      expect(
        declaredAllowedHosts({ allowedHosts: "api.vendor.com" })
      ).toBeUndefined();
      expect(declaredAllowedHosts({ allowedHosts: ["a", 1, "b"] })).toEqual([
        "a",
        "b",
      ]);
    });
  });
});

/**
 * The JSONB keys the applier MERGES onto an existing tool row — read out of the
 * `.set({...})` in `applyTemplateToExistingTool` (a key whose value is a
 * `mergePreservingExisting(` call), never re-listed here. The existing-tool
 * branch must still call that helper, or the scan would watch dead code.
 */
function applierMergedToolKeys(): string[] {
  const src = readFileSync(join(here, "create-from-definition.ts"), "utf8");
  const branch = src.indexOf("if (existingTool) {");
  expect(branch, "applier's existing-tool branch not found").toBeGreaterThan(
    -1
  );
  const branchEnd = src.indexOf("continue;", branch);
  expect(
    src.slice(branch, branchEnd).includes("applyTemplateToExistingTool("),
    "the existing-tool branch no longer writes through applyTemplateToExistingTool"
  ).toBe(true);
  const helper = src.indexOf(
    "export async function applyTemplateToExistingTool("
  );
  expect(helper, "applyTemplateToExistingTool not found").toBeGreaterThan(-1);
  const start = src.indexOf(".update(toolsTable)", helper);
  const setStart = src.indexOf(".set({", start);
  const end = src.indexOf(".where(eq(toolsTable.id, toolId))", setStart);
  expect(start, "the helper's tool update not found").toBeGreaterThan(helper);
  expect(end, "end of the helper's tool update not found").toBeGreaterThan(
    setStart
  );
  const keys: string[] = [];
  for (const line of src.slice(setStart, end).split("\n")) {
    const m = /^\s+(\w+):\s*mergePreservingExisting\(/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("drift comparator ↔ applier projection parity (tool row merged JSONB)", () => {
  it("reads EXACTLY the fields the applier merges onto an existing tool", () => {
    const merged = applierMergedToolKeys().sort();
    expect(
      merged.length,
      "extracted no merged tool keys from the applier — the extraction is broken"
    ).toBeGreaterThanOrEqual(2);
    expect(
      [...PROJECTED_TOOL_MERGE_FIELDS].sort(),
      `the applier merges ${JSON.stringify(merged)} onto an existing tool; the ` +
        `comparator must read exactly those. A merged field it does not read ` +
        `can never reach an installed pod. ${WHY_IT_MATTERS}`
    ).toEqual(merged);
  });

  for (const field of PROJECTED_TOOL_MERGE_FIELDS) {
    it(`a template that only ADDS a ${field} default is drift`, () => {
      expect(
        capabilityToolMergeDrift(
          [{ name: "google", [field]: { existing: 1 } }],
          [
            {
              name: "google",
              [field]: { existing: 0, sync: { enabled: true } },
            },
          ]
        ).drifted,
        `a template change touching ONLY tools[].${field} is invisible. ${WHY_IT_MATTERS}`
      ).toEqual(["google"]);
    });
  }

  const TEMPLATE_SYNC = {
    sync: {
      enabled: true,
      kinds: { event: { enabled: true, windowDays: 90, itemLimit: 200 } },
    },
  };

  it("a user override of a declared leaf is NOT drift (overrides survive)", () => {
    const live = {
      sync: {
        enabled: false,
        kinds: { event: { enabled: true, windowDays: 30, itemLimit: 200 } },
      },
    };
    expect(
      capabilityToolMergeDrift(
        [{ name: "google", metadata: live }],
        [{ name: "google", metadata: TEMPLATE_SYNC }]
      ).drifted
    ).toEqual([]);
  });

  it("a row converged by ONE apply is not drift again (no re-apply loop), runtime state included", () => {
    const partial = {
      discord: { channel: "c1" },
      sync: { kinds: { event: { connections: { c1: { cursor: "x" } } } } },
    };
    const applied = mergePreservingExisting(TEMPLATE_SYNC, partial);
    expect(
      capabilityToolMergeDrift(
        [{ name: "google", metadata: partial }],
        [{ name: "google", metadata: TEMPLATE_SYNC }]
      ).drifted
    ).toEqual(["google"]);
    expect(
      capabilityToolMergeDrift(
        [{ name: "google", metadata: applied }],
        [{ name: "google", metadata: TEMPLATE_SYNC }]
      ).drifted
    ).toEqual([]);
  });

  it("skips a templated tool name, an absent tool, and a template with no defaults", () => {
    expect(
      capabilityToolMergeDrift(
        [],
        [{ name: "google", metadata: TEMPLATE_SYNC }]
      ).drifted
    ).toEqual([]);
    expect(
      capabilityToolMergeDrift(
        [{ name: "{{p}} api", metadata: {} }],
        [{ name: "{{p}} api", metadata: TEMPLATE_SYNC }]
      ).drifted
    ).toEqual([]);
    expect(
      capabilityToolMergeDrift(
        [{ name: "google", metadata: { anything: 1 } }],
        [{ name: "google" }]
      ).drifted
    ).toEqual([]);
  });
});

describe("drift comparator ↔ applier projection parity (tool verb catalog)", () => {
  const skill = {
    name: "gmail_send",
    description: "Send an email",
    parameters: { to: {} },
    intent: "send_message" as const,
    requires: ["gmail"],
  };
  const projected = () => deriveToolVerbs("gmail", [skill], "propose");

  it("compares every key the applier's verb projection emits", () => {
    const [entry] = projected();
    expect(Object.keys(entry).sort()).toEqual(
      ["argsSchema", "govDefault", "id", "intent", "kind", "label"].sort()
    );
    for (const key of Object.keys(entry) as Array<keyof ToolVerbCatalogEntry>) {
      if (key === "id") continue; // the match key — a changed id is a MISSING verb, covered below
      const live = { ...entry, [key]: "__perturbed__" } as ToolVerbCatalogEntry;
      expect(
        capabilityVerbCatalogDrift(
          [{ name: "gmail", capabilityCatalog: [live] }],
          new Map([["gmail", projected()]])
        ).drifted,
        `the verb catalog's "${key}" is not compared, so a template change to it ` +
          `reaches no pod. ${WHY_IT_MATTERS}`
      ).toEqual(["gmail"]);
    }
  });

  it("a template that ADDS intent to an existing verb is drift (the shipped miss)", () => {
    const legacy = projected().map((v) => {
      const { intent: _dropped, ...rest } = v;
      return rest as ToolVerbCatalogEntry;
    });
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "gmail", capabilityCatalog: legacy }],
        new Map([["gmail", projected()]])
      ).drifted
    ).toEqual(["gmail"]);
  });

  it("an already-converged catalog is not drift", () => {
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "gmail", capabilityCatalog: projected() }],
        new Map([["gmail", projected()]])
      ).drifted
    ).toEqual([]);
  });

  it("a verb the template does not declare is NOT drift (additive contract)", () => {
    const withExtra = [
      ...projected(),
      {
        id: "custom_verb",
        label: "custom",
        kind: "read",
        govDefault: "propose",
      } as ToolVerbCatalogEntry,
    ];
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "gmail", capabilityCatalog: withExtra }],
        new Map([["gmail", projected()]])
      ).drifted
    ).toEqual([]);
  });

  it("a declared verb missing from the live catalog is drift", () => {
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "gmail", capabilityCatalog: [] }],
        new Map([["gmail", projected()]])
      ).drifted
    ).toEqual(["gmail"]);
  });

  it("skips a templated tool name and an unmatched tool (never a false positive)", () => {
    expect(
      capabilityVerbCatalogDrift([], new Map([["{{name}} api", projected()]]))
        .drifted
    ).toEqual([]);
    // Absent tool row = missingToolMemberships' concern, not this diff's.
    expect(
      capabilityVerbCatalogDrift([], new Map([["gmail", projected()]])).drifted
    ).toEqual([]);
  });
});
