import { describe, it, expect } from "vitest";
import { blame, type BlameCheckpoint } from "./blame.js";

const cp = (
  version: number,
  authorKind: string,
  authorId: string,
  content: string,
  proposalId?: string
): BlameCheckpoint => ({
  version,
  authorKind,
  authorId,
  content,
  ...(proposalId ? { proposalId } : {}),
});

describe("blame", () => {
  it("an empty chain blames nothing", () => {
    expect(blame([])).toEqual({ lines: [], ranges: [], blocks: [] });
  });

  it("unchanged lines keep their author; inserted and edited lines take the new one", () => {
    const chain = [
      cp(1, "user", "u1", "# Title\n\nIntro by a human.\n\nOutro."),
      cp(
        2,
        "ai",
        "agent-7",
        "# Title\n\nIntro by a human.\n\nAn AI paragraph.\n\nOutro.",
        "prop-1"
      ),
      cp(
        3,
        "user",
        "u1",
        "# Title\n\nIntro by a human, edited.\n\nAn AI paragraph.\n\nOutro."
      ),
    ];
    const { lines, ranges, blocks } = blame(chain);
    expect(lines.map((l) => `${l.authorKind}:${l.version}`)).toEqual([
      "user:1", // # Title
      "user:1", // blank
      "user:3", // edited intro
      "user:1", // blank (matched)
      "ai:2", // AI paragraph
      "ai:2", // blank inserted with it
      "user:1", // Outro.
    ]);
    expect(lines[4]).toMatchObject({
      authorId: "agent-7",
      proposalId: "prop-1",
    });
    expect(ranges.map((r) => [r.startLine, r.endLine, r.version])).toEqual([
      [1, 2, 1],
      [3, 3, 3],
      [4, 4, 1],
      [5, 6, 2],
      [7, 7, 1],
    ]);
    expect(blocks.map((b) => [b.startLine, b.endLine, b.version])).toEqual([
      [1, 1, 1],
      [3, 3, 3],
      [5, 5, 2],
      [7, 7, 1],
    ]);
  });

  it("orders by version regardless of input order, and a deletion leaves no trace", () => {
    const { lines } = blame([
      cp(2, "ai", "a", "a\nc"),
      cp(1, "user", "u", "a\nb\nc"),
    ]);
    expect(lines.map((l) => l.version)).toEqual([1, 1]);
  });

  it("a block lists every writer that touched it, last hand wins", () => {
    const { blocks } = blame([
      cp(1, "user", "u", "one\ntwo"),
      cp(2, "ai", "a", "one\nTWO"),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.version).toBe(2);
    expect(blocks[0]!.authors.map((a) => a.version)).toEqual([1, 2]);
  });

  it("moved lines: LCS keeps the longest common run", () => {
    const { lines } = blame([
      cp(1, "user", "u", "a\nb\nc\nd"),
      cp(2, "ai", "x", "c\nd\na\nb"),
    ]);
    // "c\nd" or "a\nb" survives; the other half is re-attributed. Exactly two lines keep v1.
    expect(lines.filter((l) => l.version === 1)).toHaveLength(2);
  });
});
