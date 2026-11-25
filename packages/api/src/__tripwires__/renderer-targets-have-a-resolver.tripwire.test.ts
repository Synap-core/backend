/**
 * TRIPWIRE — every renderer target can be opened, and what its door writes is
 * what its page reads.
 *
 * A renderer target (`RENDERER_TARGETS`: a kind's records, or one capability,
 * playbook or view) claims slots. The claim is worth something only when
 *   (a) the target is an object `resolveObjectKind` can open — the doors check
 *       a per-object target through that one prober, so a kind it does not
 *       probe could never be bound; and
 *   (b) a binding written through the target's store comes back from the
 *       store's READER (`RENDERER_STORE_READERS`, the same resolution the
 *       desktop's read doors run).
 *
 * The set is DERIVED: it walks `RENDERER_TARGET_KINDS`, never a list typed
 * here, so a fifth target kind is checked the day it is declared. The writes
 * go through the real services (`setProfileRenderer`, `setCapabilityRenderer`)
 * on a real PGlite, and the reads through the real resolvers.
 *
 * The failure this exists for: a target declared in the vocabulary (and
 * advertised by `synap_promote_cell_to_renderer`) whose binding the write door
 * refuses, or writes where no reader looks — "built but severed", the class
 * `renderer-binding-scope-reaches-resolver.test.ts` caught once already.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { PROBE_ORDER } from "../services/diagnose/resolve-object-kind.js";
import { setProfileRenderer } from "../services/profiles/set-profile-renderer.js";
import { setCapabilityRenderer } from "../services/capabilities/set-capability-renderer.js";
import { withCapabilityPage } from "../services/capabilities/bind-capability-renderer.js";
import {
  RENDERER_TARGETS,
  RENDERER_TARGET_KINDS,
  type RendererStore,
  type RendererTarget,
} from "../services/renderers/renderer-targets.js";
import {
  RENDERER_STORE_READERS,
  readBoundRenderer,
} from "../services/renderers/renderer-target-checks.js";
import type { RendererSlot } from "../services/profiles/renderer-slots.js";

const USER = randomUUID();
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

/**
 * How each STORE is written — the apply half of its door, exactly as the
 * door (and its proposal executor) calls it. Keyed by `RendererStore`, so a
 * new store does not typecheck here until it says how it is written.
 */
const WRITE: Record<
  RendererStore,
  (target: RendererTarget, slot: RendererSlot, cellKey: string) => Promise<void>
> = {
  renderer_bindings: async (target, slot, cellKey) => {
    // A per-object target must be an object the writer can open (the write
    // door checks it, `assertRendererBindingTarget`): the writer's own
    // pod-wide playbook or personal view.
    if (target.kind === "playbook") {
      await q(
        `insert into playbooks (id, name, created_by, goal_template) values ($1, $2, $3, 'g')`,
        [target.id, "Renderer target playbook", USER]
      );
    } else if (target.kind === "view") {
      await q(
        `insert into views (id, name, type, user_id) values ($1, $2, 'kanban', $3)`,
        [target.id, "Renderer target view", USER]
      );
    }
    await setProfileRenderer({
      userId: USER,
      workspaceId: null,
      profileSlug: target.kind === "profile" ? target.slug : target.kind,
      subjectId: target.kind === "profile" ? null : target.id,
      slot,
      ref: { kind: "cell", cellKey, props: {} },
      // A personal binding: no role floor to stand up, same store and reader.
      scope: "user",
    });
  },
  capability_pages: async (target, slot, cellKey) => {
    const id = (target as { id: string }).id;
    await q(
      `insert into capabilities (id, name, metadata) values ($1, $2, '{}'::jsonb)`,
      [id, "Renderer target capability"]
    );
    await setCapabilityRenderer({
      userId: USER,
      workspaceId: null,
      capabilityId: id,
      pages: withCapabilityPage([], slot, { kind: "cell", cellKey, props: {} }),
      scope: "capability",
    });
  },
};

function targetFor(
  kind: (typeof RENDERER_TARGET_KINDS)[number]
): RendererTarget {
  return kind === "profile"
    ? { kind, slug: "task" }
    : { kind, id: randomUUID() };
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'renderer-targets@x.test', 'Renderer targets', 'human')`,
    [USER]
  );
});

describe("renderer targets have a resolver", () => {
  it("the derivation is not vacuous: four targets, both stores", () => {
    expect([...RENDERER_TARGET_KINDS].sort()).toEqual(
      expect.arrayContaining(["capability", "playbook", "profile", "view"])
    );
    const stores = new Set(
      RENDERER_TARGET_KINDS.map((k) => RENDERER_TARGETS[k].store)
    );
    expect([...stores].sort()).toEqual([
      "capability_pages",
      "renderer_bindings",
    ]);
  });

  it.each(RENDERER_TARGET_KINDS)(
    "%s is a kind resolveObjectKind can open",
    (kind) => {
      expect(
        PROBE_ORDER as readonly string[],
        `${kind} resolves as '${RENDERER_TARGETS[kind].openAs}', which the one id → kind prober never probes: no door can check the object, so nothing can ever be bound to it`
      ).toContain(RENDERER_TARGETS[kind].openAs);
    }
  );

  it.each(RENDERER_TARGET_KINDS)(
    "%s: what its store's door writes, its store's reader returns",
    async (kind) => {
      const def = RENDERER_TARGETS[kind];
      expect(
        Object.hasOwn(RENDERER_STORE_READERS, def.store),
        `store '${def.store}' has no reader`
      ).toBe(true);
      const slot: RendererSlot = (
        def.slots as readonly RendererSlot[]
      ).includes("detail")
        ? "detail"
        : def.slots[0]!;
      const target = targetFor(kind);
      const cellKey = `generated:${kind}-page`;

      // Nothing bound yet: the reader says so (not a fallback ref).
      expect(
        await readBoundRenderer({
          target,
          slot,
          userId: USER,
          workspaceId: null,
        })
      ).toBeNull();

      await WRITE[def.store](target, slot, cellKey);

      const bound = await readBoundRenderer({
        target,
        slot,
        userId: USER,
        workspaceId: null,
      });
      expect(bound?.ref).toMatchObject({ kind: "cell", cellKey });
    }
  );

  it("a per-object binding answers for THAT object only", async () => {
    const one = { kind: "playbook" as const, id: randomUUID() };
    const other = { kind: "playbook" as const, id: randomUUID() };
    await WRITE.renderer_bindings(one, "detail", "generated:one-playbook");
    expect(
      await readBoundRenderer({
        target: other,
        slot: "detail",
        userId: USER,
        workspaceId: null,
      })
    ).toBeNull();
  });
});
