/**
 * The seam between markdown-core (which parses and writes embed directives)
 * and the one Block (`@synap-core/types/blocks`, which reads them): real
 * markdown → `locateEmbeds` → `embedToBlock` → `blockToEmbed` →
 * `serializeEmbed` → parsed again gives the same Block. `insert_embed`'s
 * directive list is derived from the Block, and is the three it always was.
 */
import { describe, expect, it } from "vitest";
import { serializeEmbed } from "@synap-core/markdown-core/embeds";
import { locateEmbeds } from "@synap-core/markdown-core/readable";
import { blockToEmbed, embedToBlock } from "@synap-core/types/blocks";
import { DocumentPatchOpsSchema } from "./patch-ops.js";

const VIEW = "6f1c3a52-9a7e-4d0c-8e3f-2b1a0c9d8e7f";
const ENTITY = "8f14e45f-ceea-4e7d-9b2a-1c2d3e4f5a6b";
const INSTANCE = "0b6a2f6e-41a3-4b8e-9d2c-5e7f1a3c9b04";

const DOC = [
  "# Weekly",
  "",
  `:::synap-entity{id="${ENTITY}"}`,
  "Acme deal",
  ":::",
  "",
  `:::synap-view{viewId="${VIEW}"}`,
  ":::",
  "",
  ':::synap-cell{cellKey="stat-card"}',
  "```json",
  '{"metric":"count","profileSlug":"deal"}',
  "```",
  "12 deals",
  ":::",
  "",
  `:::synap-cell{instanceId="${INSTANCE}"}`,
  ":::",
  "",
  // The legacy attribute props channel (read, never written).
  `:::synap-cell{cellKey="greeting" cellProps="{&#x22;name&#x22;:&#x22;Ana&#x22;}"}`,
  ":::",
].join("\n");

describe("markdown embeds read into the one Block and write back", () => {
  const blocks = locateEmbeds(DOC).map(({ embed }) => embedToBlock(embed));

  it("reads every block embed of a real document", () => {
    expect(blocks).toEqual([
      { kind: "entity", entityId: ENTITY },
      { kind: "view", viewId: VIEW },
      {
        kind: "cell",
        cellKey: "stat-card",
        props: { metric: "count", profileSlug: "deal" },
      },
      { kind: "cell", instanceId: INSTANCE },
      { kind: "cell", cellKey: "greeting", props: { name: "Ana" } },
    ]);
  });

  it("writes each Block as a directive markdown-core reads back to the same Block", () => {
    for (const block of blocks) {
      const written = serializeEmbed(blockToEmbed(block!));
      const [again] = locateEmbeds(written);
      expect(embedToBlock(again!.embed)).toEqual(block);
    }
  });
});

describe("insert_embed's directives are the Block's", () => {
  it("accepts the three block directives and refuses synap-ask", () => {
    const op = (directive: string) => [
      { op: "insert_embed", directive, ref: { id: "x" } },
    ];
    for (const d of ["synap-entity", "synap-view", "synap-cell"]) {
      expect(DocumentPatchOpsSchema.safeParse(op(d)).success, d).toBe(true);
    }
    expect(DocumentPatchOpsSchema.safeParse(op("synap-ask")).success).toBe(
      false
    );
  });
});
