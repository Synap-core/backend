/**
 * The one Block (`blocks/index.ts`): every stored spelling of a placed view,
 * entity or cell reads into the same Block, the bento schema keeps a cell's
 * instance, and the placement rule (no inline props on an instance) is held
 * where the bento is written.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCK_KINDS,
  BLOCK_PROPS_ON_INSTANCE,
  BlockSchema,
  blockToEmbed,
  embedToBlock,
  readLegacyBlock,
  type Block,
} from "./index.js";
import {
  BentoBlockSchema,
  BentoViewConfigSchema,
  validateViewConfig,
} from "../views/config-schemas.js";

const VIEW = "6f1c3a52-9a7e-4d0c-8e3f-2b1a0c9d8e7f";
const ENTITY = "8f14e45f-ceea-4e7d-9b2a-1c2d3e4f5a6b";
const INSTANCE = "0b6a2f6e-41a3-4b8e-9d2c-5e7f1a3c9b04";
const POS = { x: 0, y: 0, w: 4, h: 3 };

describe("readLegacyBlock: every legacy spelling reads into the one Block", () => {
  const cases: Array<[string, unknown, Block]> = [
    [
      "bento view",
      { id: "b1", kind: "view", viewId: VIEW, pos: POS, chrome: "card" },
      { kind: "view", viewId: VIEW },
    ],
    [
      "bento view with overrides",
      {
        id: "b1",
        kind: "view",
        viewId: VIEW,
        pos: POS,
        overrides: { limit: 5 },
      },
      { kind: "view", viewId: VIEW, overrides: { limit: 5 } },
    ],
    [
      "bento entity",
      {
        id: "b2",
        kind: "entity",
        entityId: ENTITY,
        pos: POS,
        variant: "compact",
      },
      { kind: "entity", entityId: ENTITY, variant: "compact" },
    ],
    [
      "bento widget (widgetType + config)",
      {
        id: "b3",
        kind: "widget",
        widgetType: "stat-card",
        pos: POS,
        config: { metric: "count" },
        query: { scopeProfileIds: [] },
      },
      { kind: "cell", cellKey: "stat-card", props: { metric: "count" } },
    ],
    [
      "bento widget without config",
      { id: "b3", kind: "widget", widgetType: "greeting", pos: POS },
      { kind: "cell", cellKey: "greeting" },
    ],
    [
      "bento widget with cellInstanceId (props live on the instance)",
      {
        id: "b4",
        kind: "widget",
        widgetType: "html-embed",
        cellInstanceId: INSTANCE,
        pos: POS,
      },
      { kind: "cell", cellKey: "html-embed", instanceId: INSTANCE },
    ],
    [
      "canonical bento cell",
      {
        id: "b5",
        kind: "cell",
        cellKey: "stat-card",
        props: { a: 1 },
        pos: POS,
      },
      { kind: "cell", cellKey: "stat-card", props: { a: 1 } },
    ],
    [
      "sheet canvas cell (range placement)",
      {
        id: "s1",
        kind: "cell",
        cellKey: "chart-bar",
        props: { x: "status" },
        range: { start: "A1", end: "C4" },
        title: "Chart",
      },
      { kind: "cell", cellKey: "chart-bar", props: { x: "status" } },
    ],
    [
      "sheet canvas view",
      {
        id: "s2",
        kind: "view",
        viewId: VIEW,
        range: { start: "A1", end: "B2" },
      },
      { kind: "view", viewId: VIEW },
    ],
    [
      "whiteboard cell shape (cellProps JSON string, no kind)",
      {
        cellKey: "stat-card",
        cellProps: '{"metric":"sum"}',
        cellInstanceId: "",
        w: 300,
        h: 200,
      },
      { kind: "cell", cellKey: "stat-card", props: { metric: "sum" } },
    ],
    [
      "whiteboard cell shape backed by an instance",
      {
        cellKey: "html-embed",
        cellProps: '{"ignored":true}',
        cellInstanceId: INSTANCE,
      },
      { kind: "cell", cellKey: "html-embed", instanceId: INSTANCE },
    ],
    [
      "whiteboard view shape",
      { viewId: VIEW, viewType: "table", referenceMode: "live" },
      { kind: "view", viewId: VIEW },
    ],
    [
      "whiteboard entity card shape",
      { entityId: ENTITY, entityType: "deal", title: "Acme" },
      { kind: "entity", entityId: ENTITY },
    ],
  ];

  it.each(cases)("%s", (_name, raw, expected) => {
    const block = readLegacyBlock(raw);
    expect(block).toEqual(expected);
    // What it read is a valid Block, and reading the Block again is a fixpoint.
    expect(BlockSchema.safeParse(block).success).toBe(true);
    expect(readLegacyBlock(block)).toEqual(expected);
  });

  it("refuses what names nothing drawable, and props it cannot read", () => {
    expect(readLegacyBlock(null)).toBeNull();
    expect(readLegacyBlock({ kind: "view" })).toBeNull();
    expect(readLegacyBlock({ kind: "entity", entityId: "" })).toBeNull();
    expect(readLegacyBlock({ kind: "widget", widgetType: "" })).toBeNull();
    expect(readLegacyBlock({ kind: "note", content: "x" })).toBeNull();
    // Unreadable props are not "no props": the cell would draw empty.
    expect(
      readLegacyBlock({ cellKey: "stat-card", cellProps: "{not json" })
    ).toBeNull();
    expect(
      readLegacyBlock({ kind: "widget", widgetType: "x", config: [1, 2] })
    ).toBeNull();
  });

  it("an instance-only cell reads without a key", () => {
    expect(readLegacyBlock({ kind: "cell", instanceId: INSTANCE })).toEqual({
      kind: "cell",
      instanceId: INSTANCE,
    });
  });
});

describe("markdown embeds ↔ Block", () => {
  const embeds: Array<[string, Parameters<typeof embedToBlock>[0], Block]> = [
    [
      "entity",
      { directive: "synap-entity", ref: { id: ENTITY } },
      { kind: "entity", entityId: ENTITY },
    ],
    [
      "view",
      { directive: "synap-view", ref: { viewId: VIEW } },
      { kind: "view", viewId: VIEW },
    ],
    [
      "view (legacy data-view-id)",
      { directive: "synap-view", ref: { "data-view-id": VIEW } },
      { kind: "view", viewId: VIEW },
    ],
    [
      "inline cell with props",
      {
        directive: "synap-cell",
        ref: { cellKey: "stat-card" },
        props: { metric: "count" },
      },
      { kind: "cell", cellKey: "stat-card", props: { metric: "count" } },
    ],
    [
      "instance cell",
      { directive: "synap-cell", ref: { instanceId: INSTANCE } },
      { kind: "cell", instanceId: INSTANCE },
    ],
    [
      "cell (legacy data-cell-key)",
      { directive: "synap-cell", ref: { "data-cell-key": "greeting" } },
      { kind: "cell", cellKey: "greeting" },
    ],
  ];

  it.each(embeds)("%s round-trips", (_name, embed, expected) => {
    const block = embedToBlock(embed);
    expect(block).toEqual(expected);
    expect(embedToBlock(blockToEmbed(block!))).toEqual(expected);
  });

  it("an ask and a reference-less embed are not blocks", () => {
    expect(
      embedToBlock({
        directive: "synap-ask",
        ref: { sessionId: "s", slot: "x" },
      })
    ).toBeNull();
    expect(embedToBlock({ directive: "synap-cell", ref: {} })).toBeNull();
  });

  it("writes the canonical reference attributes", () => {
    expect(
      blockToEmbed({ kind: "cell", cellKey: "stat-card", props: { a: 1 } })
    ).toEqual({
      directive: "synap-cell",
      ref: { cellKey: "stat-card" },
      props: { a: 1 },
    });
  });
});

describe("the bento schema is built on the Block", () => {
  const bento = (blocks: unknown[]) => ({ layout: "bento", blocks });

  it("keeps a legacy widget tile's cellInstanceId (it used to be stripped)", () => {
    const parsed = BentoViewConfigSchema.parse(
      bento([
        {
          id: "t",
          kind: "widget",
          widgetType: "html-embed",
          cellInstanceId: INSTANCE,
          pos: POS,
        },
      ])
    );
    expect(parsed.blocks[0]).toMatchObject({ cellInstanceId: INSTANCE });
  });

  it("accepts the canonical cell tile, with its instanceId", () => {
    const parsed = BentoViewConfigSchema.parse(
      bento([
        {
          id: "c",
          kind: "cell",
          cellKey: "stat-card",
          props: { a: 1 },
          pos: POS,
        },
        {
          id: "i",
          kind: "cell",
          cellKey: "html-embed",
          instanceId: INSTANCE,
          pos: POS,
        },
      ])
    );
    expect(parsed.blocks[1]).toMatchObject({ instanceId: INSTANCE });
  });

  it("still accepts every legacy tile shape", () => {
    expect(
      validateViewConfig(
        "bento",
        bento([
          { id: "v", kind: "view", viewId: VIEW, pos: POS, chrome: "card" },
          {
            id: "e",
            kind: "entity",
            entityId: ENTITY,
            pos: POS,
            variant: "detailed",
          },
          {
            id: "w",
            kind: "widget",
            widgetType: "stat-card",
            config: { m: 1 },
            pos: POS,
          },
        ])
      ).valid
    ).toBe(true);
  });

  it("holds the placement rule: no inline props on an instance, in either spelling", () => {
    for (const tile of [
      {
        id: "c",
        kind: "cell",
        cellKey: "k",
        instanceId: INSTANCE,
        props: { a: 1 },
        pos: POS,
      },
      {
        id: "w",
        kind: "widget",
        widgetType: "k",
        cellInstanceId: INSTANCE,
        config: { a: 1 },
        pos: POS,
      },
    ]) {
      const result = BentoBlockSchema.safeParse(tile);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(
        BLOCK_PROPS_ON_INSTANCE
      );
    }
  });

  it("refuses a cell tile without its key (a bento draws by key, an instance alone is not enough)", () => {
    expect(
      BentoBlockSchema.safeParse({ id: "c", kind: "cell", pos: POS }).success
    ).toBe(false);
    expect(
      BentoBlockSchema.safeParse({
        id: "c",
        kind: "cell",
        instanceId: INSTANCE,
        pos: POS,
      }).success
    ).toBe(false);
  });

  it("has an arm for every Block kind", () => {
    for (const kind of BLOCK_KINDS) {
      const tile =
        kind === "view"
          ? { id: "a", kind, viewId: VIEW, pos: POS }
          : kind === "entity"
            ? { id: "a", kind, entityId: ENTITY, pos: POS }
            : { id: "a", kind, cellKey: "k", pos: POS };
      expect(BentoBlockSchema.safeParse(tile).success, kind).toBe(true);
    }
  });
});
