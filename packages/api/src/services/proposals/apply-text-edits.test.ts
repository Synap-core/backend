/**
 * A revise changes part of a long text field without resending it (ticket
 * e1d590e1: fixing four colour lines of a pending cell meant resending 18 KB).
 * `applyTextEdits` turns `textEdits` into a whole field value BEFORE the
 * revise checks run, so every protection sees an ordinary `fields` patch.
 */
import { describe, expect, it } from "vitest";
import { applyTextEdits, computeRevisedEnvelope } from "./proposals-service.js";

const SOURCE = [
  "export default function Card() {",
  '  const tone = "#ff0000";',
  '  const edge = "#00ff00";',
  "  return null;",
  "}",
].join("\n");
const cellProposal = () => ({
  targetType: "cell",
  changeType: "define",
  data: { name: "Radar card", rendererSource: SOURCE },
});

describe("applyTextEdits", () => {
  it("replaces the one occurrence in the stored inner field, leaving the rest byte for byte", () => {
    const out = applyTextEdits(cellProposal(), {
      kind: "inner",
      fields: {},
      textEdits: [
        {
          field: "rendererSource",
          find: '"#ff0000"',
          replace: "var(--synap-accent)",
        },
      ],
    });
    expect(out.fields.rendererSource).toBe(
      SOURCE.replace('"#ff0000"', "var(--synap-accent)")
    );
    expect(out).not.toHaveProperty("textEdits");
  });

  it("applies edits in order, on top of a field the same patch sets", () => {
    const out = applyTextEdits(cellProposal(), {
      kind: "inner",
      fields: { rendererSource: "a b c" },
      textEdits: [
        { field: "rendererSource", find: "b", replace: "B" },
        { field: "rendererSource", find: "a B", replace: "x" },
      ],
    });
    expect(out.fields.rendererSource).toBe("x c");
  });

  it("refuses a find that is absent or ambiguous, naming it, and revises nothing", () => {
    expect(() =>
      applyTextEdits(cellProposal(), {
        kind: "inner",
        fields: {},
        textEdits: [{ field: "rendererSource", find: "#0000ff", replace: "x" }],
      })
    ).toThrow(/does not contain "#0000ff"/);
    expect(() =>
      applyTextEdits(cellProposal(), {
        kind: "inner",
        fields: {},
        textEdits: [{ field: "rendererSource", find: "const", replace: "let" }],
      })
    ).toThrow(/occurs more than once/);
  });

  it("refuses a field that is not text", () => {
    expect(() =>
      applyTextEdits(
        { data: { rendererSource: SOURCE, size: 3 } },
        {
          kind: "inner",
          fields: {},
          textEdits: [{ field: "size", find: "3", replace: "4" }],
        }
      )
    ).toThrow(/not a text field/);
  });

  it("a patch with no textEdits is returned as is", () => {
    const patch = { kind: "inner" as const, fields: { title: "t" } };
    expect(applyTextEdits(cellProposal(), patch)).toBe(patch);
  });

  it("SEAM: a revise with textEdits stores the edited source where the approve reads it", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: cellProposal(),
      patch: {
        kind: "inner",
        fields: {},
        textEdits: [
          { field: "rendererSource", find: '"#00ff00"', replace: '"#0000ff"' },
        ],
      },
    });
    const data = merged.data as Record<string, unknown>;
    expect(data.rendererSource).toBe(SOURCE.replace('"#00ff00"', '"#0000ff"'));
    expect(data.name).toBe("Radar card");
  });
});
