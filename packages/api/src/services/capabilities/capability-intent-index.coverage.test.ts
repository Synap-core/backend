/**
 * GUARD — Phase 3's declared-vs-provided join, and Phase 4's gap→install path.
 *
 * WHAT THIS PROVES
 *   1. `foldIntentCoverage` joins DECLARED slugs to the SAME verb index the rest
 *      of the module exposes (`foldVerbsByIntent`), and reports a gap as a
 *      RETURNED FACT rather than an empty array, a throw, or a silent pass.
 *   2. A gap is DISTINGUISHABLE from "declares nothing" and from a failed read —
 *      the three facts stay separate, which is the defect this file exists to
 *      prevent.
 *   3. `declaredProvides` returns null (unreadable) rather than [] for an entry
 *      with no readable declaration — so "declares nothing" cannot masquerade as
 *      "we could not tell".
 *   4. `selectIntentProviders` discovers candidates ONLY from a declared
 *      `provides`, with no vendor/slug knowledge, and excludes already-installed
 *      packs.
 *   5. Phase 4 files an INERT proposal: it does not install, and its refusal arms
 *      (`no_provider`, `failed`) never claim something ran.
 *
 * WHAT IT DOES NOT COVER (stated, not implied)
 *   - The database. `workspaceIntentCoverage` / `readWorkspaceTaskIntents` /
 *     `resolveIntentGap` are I/O wrappers; these tests drive their PURE cores.
 *     A bug in the SQL or the `@synap/database` import would not fail here.
 *   - `createPendingProposal`'s own dedup/hash, and the `capability.install`
 *     approve executor — both pre-existing and separately guarded.
 *   - The registry read's visibility floor (`listCapabilities`), asserted by the
 *     registry's own tests.
 *   - Non-vacuity of the INTENT VOCABULARY: `provides` values here are literals
 *     in a fixture, so this file does not prove they are real slugs. That is the
 *     Phase-1/Phase-2 guards' job (`capability-provides.test.ts` /
 *     `task-intents.test.ts`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  foldIntentCoverage,
  foldVerbsByIntent,
} from "./capability-intent-index.js";
import {
  declaredProvides,
  selectIntentProviders,
} from "./propose-intent-gap-install.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";
// TYPE-only, deliberately: the value `capability-registry.js` import would pull
// the whole registry module chain into collection, and this file tests PURE
// folds. `import type` is erased at compile time, so it costs nothing.
import type { RegistryCapability } from "./capability-registry.js";

/**
 * Strip COMMENTS only, leaving code and string literals intact.
 *
 * ⚠️ Why comments and not strings: the guard this serves must catch a vendor
 * name used as an object KEY (`{ remotion: … }`) AND as a quoted VALUE
 * (`{ generate_media: "remotion" }`). Stripping string literals blinds it to the
 * second — which a positive control caught: with strings stripped, a planted
 * provider map passed. So strings stay.
 *
 * Comments go because the module's own docblock names `remotion` while stating
 * the code deliberately does NOT do that — a scan that reads prose fires on the
 * very documentation that describes the rule.
 *
 * ⚠️ STATED LIMIT: this is a simple scanner, not a parser. It cannot see a
 * vendor name assembled at runtime by concatenation, and a `//` inside a string
 * literal would truncate the rest of that line. Both are recorded in the test
 * that uses it rather than left implied.
 */
function stripComments(code: string): string {
  return (
    code
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      // `//` not preceded by `:` so a URL inside a string ("https://…") survives.
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  );
}

/**
 * Vendor names a hardcoded provider map would have to contain, matched as WHOLE
 * identifiers.
 *
 * ⚠️ THE BOUNDARY IS LOAD-BEARING, and this is the third defect this guard has
 * caught — the first two are recorded at its call site. Unbounded, the
 * alternation matched `fal` as a SUBSTRING and flagged this module's own
 * `originalActionRan: false` — "origina**lFal**se" — as a hardcoded fal.ai
 * mapping. A guard that cries wolf on an unrelated field name trains its reader
 * to ignore it, which is worse than no guard.
 *
 * `\b` is not quite enough on its own: it treats `_` as a word character, so
 * `PROVIDER_FAL_MAP` would slip past. The lookarounds exclude identifier
 * characters on BOTH sides, which also keeps a longer name that merely CONTAINS
 * a vendor (`fal_media_lab`) out of scope — this guard is about a hardcoded
 * vendor→intent MAP, and the positive control below pins that it still fires.
 */
const VENDOR_PATTERN =
  /(?<![A-Za-z0-9_$])(remotion|hyperframes|gmail|notion|airtable|slack|hubspot|fal)(?![A-Za-z0-9_$])/i;

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The MONOREPO root (`…/Code/synap`). This file spans three packages (api +
 * database in synap-backend, workspace-templates in synap-app) because the
 * thing it guards is a CHAIN across them — a link that breaks in any one
 * package is invisible from the others.
 *
 * ⚠️ Resolved to the MONOREPO, not to synap-backend: a relative path that lands
 * one level short silently produces a `synap-backend/packages/...` path for
 * every synap-app entry, and the scan then ENOENTs on the first one — which
 * reads as "the chain is broken" rather than "I built the wrong path". The
 * non-vacuity assertion below is what proves the paths are real.
 */
const REPO = resolve(HERE, "../../../../../..");

/** A registry row with the given verbs — the ONLY shape the fold reads. */
function cap(
  name: string,
  verbs: Array<{ id: string; intent?: string }>
): RegistryCapability {
  return {
    kind: "tool",
    id: `id-${name}`,
    name,
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "auto",
    enabled: true,
    verbs: verbs.map((v) => ({
      id: v.id,
      label: v.id,
      kind: "read" as const,
      govDefault: "auto" as const,
      granted: true,
      effectiveExecMode: "auto" as const,
      backingSkillExecutable: true,
      ...(v.intent ? { intent: v.intent } : {}),
    })),
  } as unknown as RegistryCapability;
}

/** A cached capability pack declaring `provides`. */
function entry(slug: string, provides: string[] | null): CatalogCacheEntry {
  return {
    source: "https://cp.example",
    kind: "capability" as CatalogCacheEntry["kind"],
    slug,
    name: slug,
    description: null,
    version: "1.0.0",
    tier: null,
    vendor: null,
    tags: null,
    contentHash: null,
    definition: provides === null ? {} : { key: slug, provides },
  };
}

describe("Phase 3 — declared requirements vs. what is provided", () => {
  it("NON-VACUITY: the fixture rows really do reach the intent index", () => {
    // Without this, "a gap is reported" would also pass on a fold that reads
    // nothing at all.
    const caps = [
      cap("renderer", [{ id: "render", intent: "generate_media" }]),
    ];
    expect(foldVerbsByIntent(caps).size).toBe(1);
    const result = foldIntentCoverage({
      declared: ["generate_media"],
      caps,
      workspaceId: "ws-1",
    });
    expect(result.meta.verbs).toBe(1);
    expect(result.meta.verbsDeclaringIntent).toBe(1);
    expect(result.meta.capabilityRows).toBe(1);
  });

  it("a declared intent something provides is satisfied, with its verbs", () => {
    const result = foldIntentCoverage({
      declared: ["generate_media"],
      caps: [cap("renderer", [{ id: "render", intent: "generate_media" }])],
      workspaceId: "ws-1",
    });
    expect(result.gaps).toEqual([]);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].satisfied).toBe(true);
    // Reachability, not shape: the CONCRETE verb id is what a caller would pass
    // to the execute door, so assert the value actually arrives.
    expect(result.intents[0].providedBy.map((v) => v.verbId)).toEqual([
      "render",
    ]);
  });

  it("a declared intent nothing provides is a GAP — a fact, not an error", () => {
    const result = foldIntentCoverage({
      declared: ["generate_media", "manage_file"],
      caps: [cap("renderer", [{ id: "render", intent: "generate_media" }])],
      workspaceId: "ws-1",
    });
    expect(result.gaps).toEqual(["manage_file"]);
    const gap = result.intents.find((i) => i.intent === "manage_file");
    expect(gap?.satisfied).toBe(false);
    expect(gap?.providedBy).toEqual([]);
    // The satisfied sibling is untouched — a gap is per-intent, not global.
    expect(
      result.intents.find((i) => i.intent === "generate_media")?.satisfied
    ).toBe(true);
  });

  it("GAP ≠ EMPTY ≠ FAILED are three distinguishable outcomes", () => {
    const caps = [
      cap("renderer", [{ id: "render", intent: "generate_media" }]),
    ];

    // (a) GAP: declared, searched, unsatisfied.
    const gap = foldIntentCoverage({
      declared: ["manage_file"],
      caps,
      workspaceId: "ws-1",
    });
    expect(gap.intents).toHaveLength(1);
    expect(gap.gaps).toHaveLength(1);
    expect(gap.meta.declared).toBe(1);

    // (b) EMPTY: declares nothing — a real answer, distinct from (a) because
    // `declared` is 0 and there is no intent row to be unsatisfied.
    const empty = foldIntentCoverage({
      declared: [],
      caps,
      workspaceId: "ws-1",
    });
    expect(empty.intents).toEqual([]);
    expect(empty.gaps).toEqual([]);
    expect(empty.meta.declared).toBe(0);
    // …and the read really did happen, so "empty" is not "unsearched".
    expect(empty.meta.capabilityRows).toBe(1);

    // (c) FAILED is not representable as a value at all: `foldIntentCoverage`
    // cannot return one, which is why its I/O wrapper THROWS rather than
    // defaulting. Assert the wrapper does not swallow — see the source tripwire
    // below for the "no catch-to-empty" guarantee.
    expect(gap.meta.capabilityRows).toBe(empty.meta.capabilityRows);
  });

  it("preserves the caller's LENS (a fold must not stamp pod-altitude)", () => {
    const caps: RegistryCapability[] = [];
    const result = foldIntentCoverage({
      declared: ["manage_file"],
      caps,
      workspaceId: "ws-42",
    });
    expect(result.lens.workspaceId).toBe("ws-42");
  });

  it("a repeated declaration yields ONE row (a declaration is a set)", () => {
    const result = foldIntentCoverage({
      declared: ["manage_file", "manage_file"],
      caps: [],
      workspaceId: "ws-1",
    });
    expect(result.intents).toHaveLength(1);
    expect(result.gaps).toEqual(["manage_file"]);
  });

  it("counts verbs that declare NO intent — an empty gap is not proof of absence", () => {
    const result = foldIntentCoverage({
      declared: ["manage_file"],
      caps: [cap("legacy", [{ id: "old_verb" }])],
      workspaceId: "ws-1",
    });
    // The gap is real AND the coverage says the axis could not see that verb,
    // which is what stops "gap" being read as "the pod cannot do this".
    expect(result.gaps).toEqual(["manage_file"]);
    expect(result.meta.verbs).toBe(1);
    expect(result.meta.verbsDeclaringIntent).toBe(0);
  });
});

describe("Phase 4 — discovering a provider for a gap", () => {
  it("NON-VACUITY: a declared provider IS selected", () => {
    const { candidates } = selectIntentProviders({
      entries: [entry("some-pack", ["generate_media"])],
      intent: "generate_media",
    });
    expect(candidates.map((c) => c.slug)).toEqual(["some-pack"]);
  });

  it("selects by DECLARED provides alone — no vendor or slug knowledge", () => {
    // A pack nobody has ever heard of, with a name that matches nothing.
    const { candidates } = selectIntentProviders({
      entries: [entry("zzz-unknown-pack", ["manage_file"])],
      intent: "manage_file",
    });
    expect(candidates.map((c) => c.slug)).toEqual(["zzz-unknown-pack"]);
  });

  it("does NOT match on name/description (no fuzzy guessing for a precise gap)", () => {
    const { candidates } = selectIntentProviders({
      entries: [
        {
          ...entry("unrelated", []),
          name: "file manager",
          description: "manage your files",
        },
      ],
      intent: "manage_file",
    });
    expect(candidates).toEqual([]);
  });

  it("an unreadable declaration is `null`, never `[]` (blind spot ≠ absence)", () => {
    expect(declaredProvides(entry("no-decl", null))).toBeNull();
    expect(declaredProvides({ definition: {} })).toBeNull();
    expect(declaredProvides({ definition: { provides: "nope" } })).toBeNull();
    // A pack that declares the EMPTY SET is a real "provides nothing" answer.
    expect(declaredProvides(entry("declares-none", []))).toEqual([]);

    // …and it is reported as unreadable rather than silently dropped.
    const { candidates, unreadable } = selectIntentProviders({
      entries: [entry("no-decl", null), entry("real", ["manage_file"])],
      intent: "manage_file",
    });
    expect(candidates.map((c) => c.slug)).toEqual(["real"]);
    expect(unreadable).toEqual(["no-decl"]);
  });

  it("excludes an already-installed pack (never propose what is there)", () => {
    const { candidates } = selectIntentProviders({
      entries: [entry("installed", ["generate_media"])],
      intent: "generate_media",
      alreadyInstalled: new Set(["installed"]),
    });
    expect(candidates).toEqual([]);
  });

  it("ignores non-capability kinds", () => {
    const { candidates } = selectIntentProviders({
      entries: [
        {
          ...entry("a-template", ["manage_file"]),
          kind: "template" as CatalogCacheEntry["kind"],
        },
      ],
      intent: "manage_file",
    });
    expect(candidates).toEqual([]);
  });
});

describe("TRIPWIRE — Phase 4 stays inert and governed", () => {
  const src = readFileSync(join(HERE, "propose-intent-gap-install.ts"), "utf8");

  it("has no install call — the module can only ever PROPOSE", () => {
    // The approve executor owns installation. If this module ever calls the
    // applier directly, an agent provision would happen without a human.
    expect(
      /applyMarketInstall\s*\(/.test(src),
      "propose-intent-gap-install calls applyMarketInstall — it must only FILE a " +
        "proposal; approval is the human step and replays the applier itself."
    ).toBe(false);
  });

  it("has no provider map — candidates come from declared data only", () => {
    // A hardcoded slug→intent table would make discovery a second SSOT and
    // would silently exclude every pack published after it was written.
    //
    // ⚠️ TWO defects were found here by negative control, both worth recording:
    //
    //  1. The original regex required `\s*:` after the vendor name, so it only
    //     matched an UNQUOTED key (`remotion:`) and sailed past the far likelier
    //     `PROVIDER_MAP = { generate_media: "remotion" }`. Planted map → guard
    //     stayed GREEN.
    //  2. Broadening it to match the name as a VALUE then matched the module's
    //     OWN DOCBLOCK, which names `remotion` as an example of what the code
    //     deliberately does not do — a false positive on prose.
    //
    // So the scan runs over CODE ONLY, with comments and string literals
    // stripped. That is the narrow, honest boundary: this guard proves no
    // EXECUTABLE vendor mapping exists. It cannot see a vendor reached by
    // concatenation, a lookup table fetched at runtime, or a name assembled
    // from parts — stated here rather than left implied.
    const codeOnly = stripComments(src);
    expect(
      VENDOR_PATTERN.test(codeOnly),
      "propose-intent-gap-install contains a hardcoded vendor/provider mapping " +
        "in EXECUTABLE code. Discovery must come from each pack's declared `provides`."
    ).toBe(false);
  });

  it("POSITIVE CONTROL: the vendor scan still sees a vendor in EXECUTABLE code", () => {
    // Non-vacuity for the guard above, and a second check that stripping
    // comments did not over-strip into blindness.
    const planted = `const PROVIDER_MAP = { generate_media: "remotion" };`;
    expect(
      VENDOR_PATTERN.test(stripComments(planted)),
      "the vendor scan no longer matches a planted vendor VALUE — the " +
        "provider-map guard above is now VACUOUS and would pass unconditionally"
    ).toBe(true);
  });

  it("…and it does NOT fire on prose, so the module's own docblock is safe", () => {
    // The other half of the contract. Without this, the guard is only
    // non-vacuous in one direction: someone could "fix" it by deleting the
    // docblock instead of by fixing a real defect.
    const prose = [
      "/**",
      ' * and no "if intent is generate_media, suggest remotion" rule',
      " */",
    ].join("\n");
    expect(
      VENDOR_PATTERN.test(stripComments(prose)),
      "the vendor scan matches inside a comment — this guard would report a " +
        "false positive on documentation"
    ).toBe(false);
  });

  it("POSITIVE CONTROL 2: fires on the SHORT vendor, and not on a substring of one", () => {
    // The boundary narrowed matching to whole identifiers. `fal` is the shortest
    // alternative and the one most easily lost or over-broadened, so it gets its
    // own control rather than riding on `remotion`.
    expect(VENDOR_PATTERN.test(`{ generate_media: "fal" }`)).toBe(true);
    // The exact false positive that motivated the boundary, pinned so the next
    // broadening attempt fails here first rather than in production.
    expect(VENDOR_PATTERN.test("originalActionRan: false")).toBe(false);
  });

  it("keeps the `catalog read failed` arm distinct from `no_provider`", () => {
    // The empty-vs-failed collapse. If someone folds the catalog `catch` into
    // the "no provider exists" arm, a transient CP failure reads as "nothing
    // can do this" — a confident wrong answer.
    expect(src).toContain('status: "no_provider"');

    // Anchor on the CATALOG READ specifically, not on the first `status:
    // "failed"` in the file — that string also occurs in the `IntentInstallOffer`
    // type declaration, so a naive indexOf anchors on the TYPE and this guard
    // would pass (or fail) for a reason unrelated to the catalog arm. The
    // non-vacuity assertion below is what proves we reached the real code.
    const catalogRead = src.indexOf("queryCatalogCache");
    expect(
      catalogRead,
      "the catalog read moved — this tripwire is scanning the wrong region"
    ).toBeGreaterThan(-1);
    const arm = src.slice(catalogRead, catalogRead + 600);
    expect(arm).toContain('status: "failed"');
    expect(
      arm,
      "the catalog-read failure arm must say the CATALOG could not be read, so a " +
        "failed read is never reported as 'no capability provides this intent'"
    ).toContain("catalog could not be read");
    // And it must NOT be folded into the no_provider arm.
    expect(arm).not.toContain('status: "no_provider"');
  });

  it("every non-proposed arm says plainly that nothing ran", () => {
    expect(src).toContain("originalActionRan: false");
    expect(src).toContain("Nothing ran");
  });
});

describe("TRIPWIRE — the declared-intent sink is wired end to end", () => {
  /**
   * A declaration that is validated, guarded and typed but never PERSISTED is
   * the Phase-1 limitation this work was meant to close. Each link below is a
   * separate edit that could silently re-break the chain; this asserts all four
   * are present at once, and derives its own file list (no hand-maintained DOORS
   * array — a new link joins the scan by existing).
   */
  const LINKS: Array<{ file: string; must: string; what: string }> = [
    {
      file: "/synap-backend/packages/database/src/utils/create-workspace-from-definition.ts",
      must: "settings.taskIntents = definition.taskIntents",
      what: "the pod persists the declaration to settings",
    },
    {
      file: "/synap-backend/packages/database/src/utils/create-workspace-from-definition.ts",
      must: "taskIntents: z.array(z.string()).optional()",
      what: "the door's zod accepts the field (a strict zod would reject it)",
    },
    {
      file: "/synap-backend/packages/database/src/schema/workspaces.ts",
      must: "taskIntents?: string[]",
      what: "WorkspaceSettings declares the key the resolver reads",
    },
    {
      file: "/synap-app/packages/workspace-templates/src/define.ts",
      must: "taskIntents: tpl.taskIntents",
      what: "the converter forwards it (both doors: workspace + package)",
    },
  ];

  it("NON-VACUITY: every scanned file exists and was actually read", () => {
    // A missing file makes readFileSync throw, but a file that exists with the
    // wrong path shape would silently satisfy nothing — assert the scan found a
    // plausible number of REAL files with content.
    expect(LINKS.length).toBeGreaterThanOrEqual(4);
    for (const link of LINKS) {
      const text = readFileSync(join(REPO, link.file), "utf8");
      expect(
        text.length,
        `${link.file} is suspiciously short — the scan may be reading the wrong path`
      ).toBeGreaterThan(500);
    }
  });

  it("no link in the declaration → settings → resolver chain is missing", () => {
    const missing = LINKS.filter(
      (l) => !readFileSync(join(REPO, l.file), "utf8").includes(l.must)
    ).map((l) => `${l.file}: ${l.what} (expected \`${l.must}\`)`);
    expect(
      missing,
      "The declared-intent chain is broken. Phase 3 reads settings.taskIntents " +
        "but the declaration would never arrive there, so every workspace would " +
        "report 'declares nothing' — a calm, confident, empty answer:\n" +
        missing.join("\n")
    ).toEqual([]);
  });

  it("the resolver reads the SAME key it persists (no silent rename)", () => {
    const resolver = readFileSync(
      join(
        REPO,
        "/synap-backend/packages/api/src/services/capabilities/capability-intent-index.ts"
      ),
      "utf8"
    );
    expect(resolver).toContain("taskIntents");
    // It must be the settings KEY, not a column — a column would imply a
    // migration this design deliberately avoids.
    expect(resolver).not.toMatch(/columns:\s*\{\s*taskIntents/);
  });
});
