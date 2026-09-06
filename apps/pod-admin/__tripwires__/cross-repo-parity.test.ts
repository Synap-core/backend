import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_SETTINGS_SECTIONS, openIn } from "../lib/open-in";

/**
 * Two cross-repo couplings that `openIn` depends on and nothing enforced.
 *
 * The whole exit-door consolidation exists because four CTAs pointed at a
 * receiver nobody had read, and one silently dropped the param it carried. A
 * `synap://` link whose receiver does not recognise it FAILS OPEN: the browser
 * does nothing and the click looks like it worked. So both couplings below
 * were, until now, held together by a code comment.
 *
 * Neither target can be imported. pod-admin lives in the synap-backend pnpm
 * workspace (`apps/*`, `packages/*`, `marketplaces/*` — see
 * `synap-backend/pnpm-workspace.yaml`), so `workspace:*` cannot reach
 * `synap-app`, and `browser/` is a third workspace again. Both are therefore
 * read as SOURCE TEXT and parsed — the same constraint, and the same house
 * pattern, as `apps/api/src/open-kinds.lock.tripwire.test.ts`.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** `synap-backend/apps/pod-admin` → the monorepo root that holds all repos. */
const REPOS = join(APP_ROOT, "../../..");

/**
 * Pull the string members out of a `export const NAME = [...] as const;` block.
 *
 * Line comments are stripped first: the browser array annotates most of its
 * members, and a quoted word inside one of those notes would otherwise be
 * parsed as a member — a false PASS, which is the direction that matters here.
 */
function constArrayMembers(source: string, name: string): string[] {
  const block = new RegExp(
    `export const ${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]\\s*as const`
  ).exec(source);
  if (!block) return [];
  return Array.from(
    block[1].replace(/\/\/.*$/gm, "").matchAll(/["']([^"']+)["']/g),
    (m) => m[1]
  );
}

// ---------------------------------------------------------------------------
// Guard 1 — settings sections
//
// `openIn({ kind: "settings", section })` emits
// `synap://open/app/settings/<section>`, which `useDeepLinkHandler` hands to
// `SettingsApp` as `route[0]`. If the id is not one browser knows, the app
// opens on its default section and the user lands somewhere they did not ask
// for — with no error anywhere.
//
// The direction asserted is one-way ON PURPOSE. `BROWSER_SETTINGS_SECTIONS` is
// documented as a SUBSET: browser having sections pod-admin never links to is
// the normal, correct state. The drift that breaks users is pod-admin emitting
// an id browser does not have.
// ---------------------------------------------------------------------------

describe("browser settings sections exist", () => {
  const APP_STORE = join(
    REPOS,
    "browser/electron/renderer/src/stores/appStore.ts"
  );
  const present = existsSync(APP_STORE);

  // Required in CI. A cross-repo guard that reports green by not running is
  // exactly the failure mode it exists to prevent — the receiver goes unread
  // again, which is how this whole class of defect started. Locally, a
  // backend-only clone may legitimately skip.
  it("can actually see the browser checkout (required in CI)", () => {
    if (process.env.CI) expect(present).toBe(true);
    else expect(typeof present).toBe("boolean");
  });

  const sections = present
    ? constArrayMembers(readFileSync(APP_STORE, "utf8"), "SETTINGS_SECTIONS")
    : [];

  // An empty extraction that then passes vacuously is the classic dead guard:
  // rename the const, or reformat the array, and every assertion below becomes
  // trivially true. Fail loudly instead.
  it.skipIf(!present)("parses SETTINGS_SECTIONS out of appStore.ts", () => {
    expect(
      sections.length,
      `Could not parse SETTINGS_SECTIONS from ${APP_STORE}. The const was ` +
        `renamed or reshaped — fix this parser, do not delete the guard.`
    ).toBeGreaterThan(10);
    expect(sections).toContain("vault");
  });

  it.skipIf(!present).each([...BROWSER_SETTINGS_SECTIONS])(
    "pod-admin's `%s` is a section browser serves",
    (section) => {
      expect(sections).toContain(section);
    }
  );
});

// ---------------------------------------------------------------------------
// Guard 2 — the `synap://` grammar
//
// `open-in.ts` hand-rolls link shapes that
// `synap-app/packages/core/deep-link-constants` already builds. pod-admin
// cannot import it (workspace boundary, above), so the coupling is FROZEN
// instead: the builders are mirrored here, `openIn` is asserted equal to the
// mirror, and the package's own source is pinned so the mirror cannot quietly
// stop describing it.
//
// Both halves are needed. The mirror alone would only prove pod-admin is
// self-consistent; the source pin alone would only prove the package has not
// changed. Together they fail if either side moves.
// ---------------------------------------------------------------------------

describe("synap:// grammar matches deep-link-constants", () => {
  const CONSTANTS = join(
    REPOS,
    "synap-app/packages/core/deep-link-constants/src/index.ts"
  );
  const present = existsSync(CONSTANTS);

  it("can actually see the synap-app checkout (required in CI)", () => {
    if (process.env.CI) expect(present).toBe(true);
    else expect(typeof present).toBe("boolean");
  });

  const src = present ? readFileSync(CONSTANTS, "utf8") : "";

  /**
   * Read a `export const NAME = '<literal>';` out of the package.
   *
   * Falls back to "" rather than undefined so the mirror below stays typed —
   * and a missing segment then produces a visibly wrong `synap:///…`, which
   * the parse assertion and every comparison catch. It cannot pass quietly.
   */
  const literal = (name: string): string =>
    new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`).exec(
      src
    )?.[1] ?? "";

  const OPEN_HOST = literal("OPEN_HOST");
  const OPEN_APP_SEGMENT = literal("OPEN_APP_SEGMENT");
  const OPEN_PROPOSAL_SEGMENT = literal("OPEN_PROPOSAL_SEGMENT");
  const OPEN_ENTITY_SEGMENT = literal("OPEN_ENTITY_SEGMENT");
  const OPEN_VIEW_SEGMENT = literal("OPEN_VIEW_SEGMENT");

  it.skipIf(!present)("parses the grammar segments out of the package", () => {
    // Same vacuity floor as guard 1: an undefined segment would make every
    // mirrored URL below read `synap://undefined/...`, and the mirror would
    // still equal itself if the mirror were built from the same undefined.
    // It is not — the mirror uses these values, so pinning them here is what
    // stops the comparison degenerating.
    expect({
      OPEN_HOST,
      OPEN_APP_SEGMENT,
      OPEN_PROPOSAL_SEGMENT,
      OPEN_ENTITY_SEGMENT,
      OPEN_VIEW_SEGMENT,
    }).toEqual({
      OPEN_HOST: "open",
      OPEN_APP_SEGMENT: "app",
      OPEN_PROPOSAL_SEGMENT: "proposal",
      OPEN_ENTITY_SEGMENT: "entity",
      OPEN_VIEW_SEGMENT: "view",
    });
  });

  /**
   * The package's four builders, pinned by the exact expression each returns.
   *
   * Freezing the RETURN EXPRESSION rather than just the function name is the
   * point: a rename is loud (TypeScript, every call site), whereas a change to
   * what the builder emits — a segment, an encoding, a query — is silent and
   * is the drift that would leave pod-admin minting a link nobody parses.
   */
  const BUILDERS: ReadonlyArray<{ name: string; emits: readonly string[] }> = [
    {
      name: "buildOpenAppLink",
      emits: [
        "const path = [OPEN_APP_SEGMENT, appId, ...route]",
        ".map(encodeURIComponent)",
        ".join('/')",
        "return `synap://${OPEN_HOST}/${path}",
      ],
    },
    {
      name: "buildOpenEntityLink",
      emits: ["return `synap://open/entity/${encodeURIComponent(entityId)}`;"],
    },
    {
      name: "buildOpenViewLink",
      emits: ["return `synap://open/view/${encodeURIComponent(viewId)}`;"],
    },
    {
      name: "buildOpenProposalLink",
      emits: [
        "return `synap://${OPEN_HOST}/${OPEN_PROPOSAL_SEGMENT}/${encodeURIComponent(proposalId)}`;",
      ],
    },
  ];

  it.skipIf(!present).each(BUILDERS)(
    "$name still exists and emits the shape this app mirrors",
    ({ name, emits }) => {
      expect(
        src,
        `${name} is gone from deep-link-constants. openIn() mirrors it — ` +
          `re-derive the mirror below from whatever replaced it.`
      ).toContain(`export function ${name}(`);
      for (const fragment of emits) expect(src).toContain(fragment);
    }
  );

  /**
   * The mirror. Byte-for-byte what the pinned expressions above compute.
   *
   * `route`/`params` are omitted from `buildOpenAppLink` here because openIn
   * emits no query params — the branch is pinned by source above instead.
   */
  const mirror = {
    app: (appId: string, route: readonly string[] = []) =>
      `synap://${OPEN_HOST}/${[OPEN_APP_SEGMENT, appId, ...route]
        .map(encodeURIComponent)
        .join("/")}`,
    entity: (id: string) =>
      `synap://${OPEN_HOST}/${OPEN_ENTITY_SEGMENT}/${encodeURIComponent(id)}`,
    view: (id: string) =>
      `synap://${OPEN_HOST}/${OPEN_VIEW_SEGMENT}/${encodeURIComponent(id)}`,
    proposal: (id: string) =>
      `synap://${OPEN_HOST}/${OPEN_PROPOSAL_SEGMENT}/${encodeURIComponent(id)}`,
  };

  // An id with a character that MUST be percent-encoded. A plain uuid would
  // pass even if one side dropped encodeURIComponent entirely.
  const ID = "a b/c#d";

  it.skipIf(!present)("app links match buildOpenAppLink", () => {
    expect(openIn({ kind: "app", appId: "marketplace" }).href).toBe(
      mirror.app("marketplace")
    );
    // The one shape that carries a route segment. Note openIn interpolates
    // `section` WITHOUT encodeURIComponent; every member of
    // BROWSER_SETTINGS_SECTIONS is lowercase-kebab, for which encoding is the
    // identity — so the two agree, and guard 1 is what keeps that true.
    for (const section of BROWSER_SETTINGS_SECTIONS) {
      expect(openIn({ kind: "settings", section }).href).toBe(
        mirror.app("settings", [section])
      );
    }
  });

  it.skipIf(!present)("object links match the object-family builders", () => {
    // `objectInApp` is the desktop form. `kind: "object"` deliberately returns
    // pod-admin's OWN web route for entity/view/proposal (it renders those),
    // so it is not the branch that mirrors these builders — asserted below.
    expect(
      openIn({ kind: "objectInApp", objectKind: "entity", id: ID }).href
    ).toBe(mirror.entity(ID));
    expect(
      openIn({ kind: "objectInApp", objectKind: "view", id: ID }).href
    ).toBe(mirror.view(ID));
    expect(
      openIn({ kind: "objectInApp", objectKind: "proposal", id: ID }).href
    ).toBe(mirror.proposal(ID));
  });

  it("web-hosted kinds stay web, and every desktop link carries a fallback", () => {
    // Not skipped: this is pod-admin-local and needs no sibling checkout.
    for (const objectKind of ["entity", "view", "proposal"]) {
      const exit = openIn({ kind: "object", objectKind, id: ID });
      expect(exit.isDesktopLink).toBe(false);
      expect(exit.href.startsWith("synap://")).toBe(false);
    }
    for (const exit of [
      openIn({ kind: "app", appId: "data" }),
      openIn({ kind: "settings", section: "vault" }),
      openIn({ kind: "objectInApp", objectKind: "entity", id: ID }),
      openIn({ kind: "object", objectKind: "session", id: ID }),
    ]) {
      expect(exit.isDesktopLink).toBe(true);
      expect(exit.fallback?.href).toBeTruthy();
    }
  });
});
