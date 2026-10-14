/**
 * System-kind presentation backfill (how system kinds are drawn), driven
 * through the REAL `ensureSystemProfiles()` on PGlite.
 *
 * Pinned:
 *  - a fresh pod: every kind in `SYSTEM_PROFILE_PRESENTATIONS` carries it in
 *    `ui_hints.presentation`, beside its icon/color/description;
 *  - an existing pod: a kind with NO presentation is backfilled, other
 *    ui_hints keys kept; a kind whose presentation a template refined
 *    (life-os `person` adds its avatar) is NOT flipped back — backfill only;
 *  - every media/fields property a system presentation names is a property
 *    the kind links (`SYSTEM_PROFILE_PROPERTY_LINKS`).
 * That every value parses under `parseProfilePresentation` is pinned on the
 * api side (`@synap/database` cannot import `@synap-core/types`).
 * The cases share ONE pod and run in order — run the file, not `-t`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import * as schema from "../schema/index.js";
import { ProfileScope } from "../schema/profiles.js";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => h.db };
});

import {
  ensureSystemProfiles,
  SYSTEM_PROFILE_PRESENTATIONS,
  SYSTEM_PROFILE_PROPERTY_LINKS,
} from "./ensure-system-profiles.js";

let pglite: Awaited<ReturnType<typeof makeLifecyclePglite>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pglite = await makeLifecyclePglite();
  db = pglite.db;
  h.db = db;
}, 120_000);
afterAll(async () => pglite?.pg.close());

async function hintsOf(slug: string): Promise<Record<string, unknown>> {
  const [p] = await db
    .select()
    .from(schema.profiles)
    .where(
      and(
        eq(schema.profiles.slug, slug),
        eq(schema.profiles.scope, ProfileScope.SYSTEM)
      )
    );
  return (p?.uiHints ?? {}) as Record<string, unknown>;
}

async function setHints(slug: string, hints: Record<string, unknown>) {
  await db
    .update(schema.profiles)
    .set({ uiHints: hints })
    .where(
      and(
        eq(schema.profiles.slug, slug),
        eq(schema.profiles.scope, ProfileScope.SYSTEM)
      )
    );
}

describe("ensureSystemProfiles — presentation backfill", () => {
  it("names only properties the kind links", () => {
    const slugs = Object.keys(SYSTEM_PROFILE_PRESENTATIONS);
    expect(slugs.length).toBeGreaterThanOrEqual(8);
    for (const slug of slugs) {
      const p = SYSTEM_PROFILE_PRESENTATIONS[slug] as {
        media?: { source: { property?: string; entityRef?: string } };
        fields?: { card?: string[]; row?: string[] };
      };
      const named = [
        p.media?.source.property,
        p.media?.source.entityRef,
        ...(p.fields?.card ?? []),
        ...(p.fields?.row ?? []),
      ].filter((s): s is string => typeof s === "string");
      const linked = new Set(
        SYSTEM_PROFILE_PROPERTY_LINKS.find(
          (l) => l.profileSlug === slug
        )?.propertySlugs.map((s) => s.slug) ?? []
      );
      for (const n of named) expect(linked.has(n), `${slug}.${n}`).toBe(true);
    }
  });

  it("a fresh pod: every listed kind carries its presentation beside its icon", async () => {
    const r = await ensureSystemProfiles();
    expect(r.error, r.error).toBeUndefined();
    for (const [slug, presentation] of Object.entries(
      SYSTEM_PROFILE_PRESENTATIONS
    )) {
      const hints = await hintsOf(slug);
      expect(hints.presentation, slug).toEqual(presentation);
      expect(typeof hints.icon, slug).toBe("string");
    }
    expect((await hintsOf("file")).presentation).toEqual({
      family: "media",
      media: { source: { documentId: true }, kind: "auto" },
    });
  }, 120_000);

  it("an existing pod: backfills a missing one, never flips a refined one", async () => {
    const bookmark = await hintsOf("bookmark");
    const { presentation: _drop, ...withoutPresentation } = bookmark;
    await setHints("bookmark", { ...withoutPresentation, mine: 1 });
    const refined = {
      family: "record",
      media: { source: { property: "avatar-url" }, kind: "image" },
    };
    await setHints("person", {
      ...(await hintsOf("person")),
      presentation: refined,
    });

    const r = await ensureSystemProfiles();
    expect(r.error, r.error).toBeUndefined();

    const after = await hintsOf("bookmark");
    expect(after.presentation).toEqual(SYSTEM_PROFILE_PRESENTATIONS.bookmark);
    expect(after.mine).toBe(1);
    expect(after.icon).toBe(bookmark.icon);
    expect((await hintsOf("person")).presentation).toEqual(refined);
  }, 120_000);
});
