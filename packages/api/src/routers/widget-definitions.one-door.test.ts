/**
 * ONE WRITE DOOR into `widget_definitions` for a cell row.
 *
 * ── THE FORK THAT WAS CLOSED ────────────────────────────────────────────────
 * `services/cells/define-cell.ts` (`defineCell`) and tRPC
 * `widgetDefinitions.upsert` both carried their own
 * `insert(widgetDefinitions).onConflictDoUpdate(...)` into the SAME rows, and
 * they had drifted on four things — every one of them in the weaker door's
 * favour, and Cell Studio used the weaker door:
 *
 *   1. `deps` — `defineCell` runs `validateDeps` (npm-name/version regexes,
 *      max 30). The router accepted `z.record(string, string)` and wrote it
 *      straight through. deps are spliced into `esm.sh` import-map URLs inside
 *      the sandboxed frame, so this door put an unvalidated string into a URL.
 *   2. realtime — `defineCell` emits `widget_definition.create|update.completed`.
 *      The router emitted nothing, so a Cell Studio save notified no browser.
 *   3. `typeKey` — the router's `^[a-z][a-z0-9-]+$` rejects colons, so an
 *      installed (`cell:<pkg>:<key>`) or AI-defined (`generated:<slug>`) cell
 *      could not be edited at all: no "install then tweak".
 *   4. `viewTypes` — two copies of the `[]` → null normalisation, one per door.
 *
 * The consolidation makes the router TRANSPORT ONLY: it keeps the owner/admin
 * gate, the `native` refusal, the arity check and the namespace floor, and
 * hands the row to `defineCell`.
 *
 * ── WHAT IS DELIBERATELY KEPT DIFFERENT ─────────────────────────────────────
 * `rendererType` and `category` differed for a REAL reason — a Cell Studio cell
 * is authored (`app-specific`, and may be an `iframe`), a package cell is
 * installed (`installed`, always `frame`). They survive as explicit PARAMETERS
 * of the one door, asserted below, rather than being flattened to one value.
 *
 * ── WHY TWO STYLES OF ASSERTION ─────────────────────────────────────────────
 * The input schema and `defineCell` are both directly reachable, so those
 * assertions are BEHAVIOURAL. The `upsert` RESOLVER is not: `workspaceProcedure`
 * validates membership against a live db before the body runs. The delegation
 * itself is therefore asserted from SOURCE, the same idiom
 * `widget-definitions.native-rejected.test.ts` uses for the sync door and the
 * `__tripwires__` use throughout — and written to fail on the exact shape a
 * revert would produce (a returning `insert(widgetDefinitions)` back in the
 * file), not on prose.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyProcedure } from "@trpc/server";

// ── db + realtime capture ───────────────────────────────────────────────────
// `defineCell` is the unit under test, so its two side effects (the row it
// writes, the event it emits) are what the mocks record.

const h = vi.hoisted(() => ({
  /** Row the SELECT in the externalHosts branch / pod-global path returns. */
  existingRows: [] as Array<Record<string, unknown>>,
  /** Rows the UPDATE branch reports as touched (drives created vs updated). */
  updatedRows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  conflictSets: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
}));

// PARTIAL mock: `routers/widget-definitions.ts` pulls in `access/registry.ts`,
// which reads real enums (`ChannelType`, …) at module scope. A total
// replacement blinds the whole file at import time. Only `getDb` is replaced —
// `and`/`eq`/`isNull` stay real and operate on the real (unmocked) columns.
vi.mock("@synap/database", async (importOriginal) => {
  const insertBuilder = () => {
    const b: Record<string, unknown> = {};
    b.values = (v: Record<string, unknown>) => {
      h.inserted.push(v);
      return b;
    };
    b.onConflictDoUpdate = (cfg: { set: Record<string, unknown> }) => {
      h.conflictSets.push(cfg.set);
      return b;
    };
    b.returning = async () => [
      { id: "row-1", createdAt: new Date(1), updatedAt: new Date(1) },
    ];
    // `await db.insert(...).values(...)` with no `.returning()` (pod-global path)
    b.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
    return b;
  };
  const updateBuilder = () => {
    const b: Record<string, unknown> = {};
    b.set = (v: Record<string, unknown>) => {
      h.updateSets.push(v);
      return b;
    };
    b.where = () => b;
    b.returning = async () => h.updatedRows;
    return b;
  };
  const selectBuilder = () => {
    const b: Record<string, unknown> = {};
    b.from = () => b;
    b.where = () => b;
    b.limit = async () => h.existingRows;
    return b;
  };
  return {
    ...(await importOriginal<typeof import("@synap/database")>()),
    getDb: async () => ({
      insert: insertBuilder,
      update: updateBuilder,
      select: selectBuilder,
    }),
  };
});

vi.mock("../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: (event: Record<string, unknown>) => {
    h.events.push(event);
  },
}));

const { defineCell } = await import("../services/cells/define-cell.js");
const { widgetDefinitionsRouter } = await import("./widget-definitions.js");

const WS = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.existingRows = [];
  h.updatedRows = [];
  h.inserted = [];
  h.conflictSets = [];
  h.updateSets = [];
  h.events = [];
});

/** Exactly the shape Cell Studio's `persistCell` sends, mapped by the router. */
function cellStudioShaped(extra: Record<string, unknown> = {}) {
  return {
    typeKey: "my-chart",
    workspaceId: WS,
    name: "My Chart",
    description: null,
    rendererType: "frame" as const,
    category: "app-specific",
    rendererSource: "export default () => null;",
    deps: { recharts: "2.12.0" },
    viewTypes: [] as string[],
    configSchema: {},
    defaultConfig: { language: "react", mode: "react" },
    userId: "user-1",
    ...extra,
  };
}

/**
 * The zod schema a tRPC procedure actually validates with — read off
 * `_def.inputs` rather than an exported copy, so this tests the schema the
 * procedure RUNS. Same helper idiom as `widget-definitions.native-rejected.test.ts`.
 */
function upsertSchema(): {
  safeParse: (value: unknown) => {
    success: boolean;
    data?: Record<string, unknown>;
  };
} {
  const inputs = (
    widgetDefinitionsRouter._def.procedures.upsert as unknown as AnyProcedure
  )._def.inputs as unknown[];
  return inputs[inputs.length - 1] as ReturnType<typeof upsertSchema>;
}

function baseInput(extra: Record<string, unknown> = {}) {
  return {
    typeKey: "my-chart",
    name: "My Chart",
    rendererType: "frame",
    rendererSource: "export default () => null;",
    ...extra,
  };
}

// ── 1. deps validation applies on the Cell Studio path ──────────────────────

describe("deps are validated on every path into the row", () => {
  it("REJECTS a Cell Studio-shaped write carrying a hostile package name", async () => {
    await expect(
      defineCell(
        cellStudioShaped({
          // The shape the old router wrote straight into an `esm.sh` import-map
          // URL: a traversal + query splice out of the pinned path.
          deps: { "../../evil?x=": "1.0.0" },
        })
      )
    ).rejects.toThrow(/Invalid package name in deps/);
    expect(h.inserted).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("REJECTS a hostile version string", async () => {
    await expect(
      defineCell(cellStudioShaped({ deps: { recharts: "2.0.0&evil=1" } }))
    ).rejects.toThrow(/Invalid version string/);
    expect(h.inserted).toHaveLength(0);
  });

  it("REJECTS more than 30 entries", async () => {
    const deps = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`pkg-${i}`, "1.0.0"])
    );
    await expect(defineCell(cellStudioShaped({ deps }))).rejects.toThrow(
      /at most 30 entries/
    );
  });

  it("accepts a well-formed scoped dependency", async () => {
    await expect(
      defineCell(cellStudioShaped({ deps: { "@scope/pkg": "^1.2.3" } }))
    ).resolves.toMatchObject({ typeKey: "my-chart" });
  });

  it("the upsert door does NOT re-declare its own deps rules", () => {
    // A second copy of the regexes here is how the two doors drifted in the
    // first place. Validation must live in `defineCell` only.
    const source = readFileSync(
      join(import.meta.dirname, "widget-definitions.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/NPM_PKG_NAME_RE|NPM_VERSION_RE/);
  });
});

// ── 2. typeKey: an installed / AI-defined cell can be EDITED ────────────────

describe("typeKey namespaces", () => {
  it("accepts a package cell key `cell:<pkg>:<key>` — install then tweak", () => {
    const parsed = upsertSchema().safeParse(
      baseInput({ typeKey: "cell:acme-crm:pipeline-board" })
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts an AI-defined cell key `generated:<slug>`", () => {
    expect(
      upsertSchema().safeParse(baseInput({ typeKey: "generated:win-rate" }))
        .success
    ).toBe(true);
  });

  it("still accepts a plain kebab key", () => {
    expect(
      upsertSchema().safeParse(baseInput({ typeKey: "win-rate-gauge" })).success
    ).toBe(true);
  });

  it("stays inside OPEN_ID_RE's character class — no slash, space, quote or uppercase", () => {
    // `typeKey` is interpolated into `/open/cell/<key>` hrefs. Widening the
    // namespace must not widen the character set.
    for (const bad of [
      "cell:acme/../x:y",
      "generated:foo bar",
      'generated:foo"bar',
      "Win-Rate",
      "cell:acme:", // empty segment
      "cell:acme", // missing the third segment
      "generated:", // missing the slug
      ":leading-colon",
    ]) {
      expect(
        upsertSchema().safeParse(baseInput({ typeKey: bad })).success,
        `expected ${bad} to be rejected`
      ).toBe(false);
    }
  });

  it("a namespaced key may be EDITED but never MINTED through this door", () => {
    // The prefix is a provenance claim two shipped surfaces read back
    // ("Made for you" reads `generated:`, the installed list parses `cell:`),
    // so the guard is an existence check, not a character rule.
    const source = readFileSync(
      join(import.meta.dirname, "widget-definitions.ts"),
      "utf8"
    );
    expect(source).toMatch(/await assertMayWriteNamespacedTypeKey\(/);
    expect(source).toMatch(/function isNamespacedTypeKey/);
  });

  it("no longer accepts `source` — the native-only field with no writer", () => {
    const parsed = upsertSchema().safeParse(
      baseInput({ source: "export default () => null" })
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("source");
  });
});

// ── 3. a save emits the realtime event ─────────────────────────────────────

describe("realtime", () => {
  it("emits widget_definition.create.completed for a Cell Studio-shaped save", async () => {
    await defineCell(cellStudioShaped());
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      eventType: "widget_definition.create.completed",
      subjectId: "my-chart",
      userId: "user-1",
      data: { typeKey: "my-chart", workspaceId: WS, changeType: "created" },
    });
  });

  it("emits .update.completed when the row already existed", async () => {
    // Pod-global path: an UPDATE that touched a row ⇒ "updated".
    h.updatedRows = [{ id: "row-1" }];
    await defineCell(cellStudioShaped({ workspaceId: null }));
    expect(h.events.at(-1)).toMatchObject({
      eventType: "widget_definition.update.completed",
      data: { changeType: "updated" },
    });
  });

  it("the upsert door does not emit a SECOND event of its own", () => {
    const source = readFileSync(
      join(import.meta.dirname, "widget-definitions.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/emitHubRealtimeEvent/);
  });
});

// ── 4. viewTypes round-trips (the Cell Studio control's wire) ───────────────

describe("viewTypes", () => {
  it("writes a declared affinity on insert", async () => {
    await defineCell(cellStudioShaped({ viewTypes: ["table", "list"] }));
    expect(h.inserted[0]).toMatchObject({
      viewRendererViewTypes: ["table", "list"],
    });
  });

  it("normalises `[]` to null — ONE encoding of 'no affinity'", async () => {
    await defineCell(cellStudioShaped({ viewTypes: [] }));
    expect(h.inserted[0]?.viewRendererViewTypes).toBeNull();
    expect(h.conflictSets[0]).toHaveProperty("viewRendererViewTypes", null);
  });

  it("trims and dedupes before storing", async () => {
    await defineCell(
      cellStudioShaped({ viewTypes: [" table", "table", "", "list"] })
    );
    expect(h.inserted[0]?.viewRendererViewTypes).toEqual(["table", "list"]);
  });

  it("OMITTING it leaves a stored affinity untouched (omit-is-silence)", async () => {
    await defineCell(cellStudioShaped({ viewTypes: undefined }));
    expect(h.conflictSets[0]).not.toHaveProperty("viewRendererViewTypes");
  });

  it("the upsert door keeps NO second copy of the normalisation", () => {
    const source = readFileSync(
      join(import.meta.dirname, "widget-definitions.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/normalizeViewTypesForUpsert/);
  });
});

// ── 5. the differences that were REAL survive as parameters ────────────────

describe("rendererType and category stay distinguishable", () => {
  it("an authored cell keeps its own category and mechanism", async () => {
    await defineCell(
      cellStudioShaped({ category: "app-specific", rendererType: "iframe" })
    );
    expect(h.inserted[0]).toMatchObject({
      category: "app-specific",
      rendererType: "iframe",
    });
    expect(h.conflictSets[0]).toMatchObject({
      category: "app-specific",
      rendererType: "iframe",
    });
  });

  it("a package/agent caller that says nothing still gets the historical defaults", async () => {
    // Byte-for-byte what `defineCell` wrote before it grew the parameters —
    // the install and MCP doors pass neither field.
    await defineCell({
      name: "Installed Cell",
      typeKey: "cell:acme:board",
      rendererSource: "export default () => null;",
      workspaceId: WS,
      userId: "user-1",
    });
    expect(h.inserted[0]).toMatchObject({
      category: "installed",
      rendererType: "frame",
    });
    // …and silence on update stays silence, so a source-only re-push cannot
    // reset a row's category or mechanism.
    expect(h.conflictSets[0]).not.toHaveProperty("category");
    expect(h.conflictSets[0]).not.toHaveProperty("rendererType");
  });

  it("defaultSize stays INSERT-ONLY — a re-push must not resize a placed cell", async () => {
    await defineCell(cellStudioShaped({ defaultSize: { w: 4, h: 3 } }));
    expect(h.inserted[0]).toMatchObject({ defaultSize: { w: 4, h: 3 } });
    expect(h.conflictSets[0]).not.toHaveProperty("defaultSize");
  });
});

// ── 6. the seam: the router writes NOTHING itself ──────────────────────────

describe("the upsert door is transport only", () => {
  // COMMENTS STRIPPED. The file's own prose explains the fork it closed and
  // names `onConflictDoUpdate` while doing so; scanning raw source would make
  // that explanation trip its own guard.
  const source = readFileSync(
    join(import.meta.dirname, "widget-definitions.ts"),
    "utf8"
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("delegates to defineCell", () => {
    expect(code).toMatch(/await defineCell\(\{/);
  });

  it("carries no insert into widget_definitions of its own", () => {
    // The exact shape a revert would restore.
    expect(code).not.toMatch(/\.insert\(widgetDefinitions\)/);
    expect(code).not.toMatch(/onConflictDoUpdate/);
  });

  it("keeps ONLY the reads and the soft-delete as direct db access", () => {
    // `get`/`list` read through scopedDb, `deactivate` flips isActive, and the
    // upsert re-reads the row it just wrote to preserve its output type. No
    // other `.set(` may appear — that would be a second writer of cell fields.
    const setCalls = code.match(/\.set\(\{/g) ?? [];
    expect(setCalls).toHaveLength(1);
    expect(code).toMatch(/isActive: false/);
  });
});
