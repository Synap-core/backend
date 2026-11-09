/**
 * The one page bridge host (`host.ts`): what a running HTML page can get from
 * its host, and every refusal, driven with a fake frame window. This is the
 * union of the two host suites it replaces (pod admin's
 * `html-bridge-host.test.ts` and the desktop's `bridge-host.test.ts`); each
 * host's own seam (its read door) stays tested in its own repo.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CELL_BRIDGE_MAX_ANSWER_CHARS,
  CELL_BRIDGE_MAX_IN_FLIGHT,
  CELL_BRIDGE_WRITE_REFUSED,
  cellBridgeAnswer,
  cellBridgeUnknownOp,
  createCellBridgeHost,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
  type CellBridgeTarget,
} from "./index.js";

/** A fake frame window that records what the host posts to it. */
function fakeFrame() {
  const posted: Array<{ message: Record<string, unknown>; target: string }> =
    [];
  const frame: CellBridgeTarget = {
    postMessage: (message, target) =>
      posted.push({ message: message as Record<string, unknown>, target }),
  };
  return { frame, posted };
}

type Read = (
  op: CellBridgeReadOp,
  params: Record<string, CellBridgeParamValue>
) => Promise<unknown>;

function setup(read: Read = async () => ({ ok: true })) {
  const { frame, posted } = fakeFrame();
  let current: CellBridgeTarget | null = frame;
  const readSpy = vi.fn(read);
  const host = createCellBridgeHost({
    frameWindow: () => current,
    read: readSpy,
  });
  const send = (data: unknown, source: unknown = frame, origin = "null") =>
    host({ source, origin, data });
  return {
    frame,
    posted,
    read: readSpy,
    send,
    replaceFrame: (next: CellBridgeTarget | null) => {
      current = next;
    },
  };
}

const query = (operation: string, params: unknown = {}, id = "q1") => ({
  type: "synap:query",
  id,
  operation,
  params,
});

describe("the page bridge host — what it refuses", () => {
  it("refuses every write, and reads nothing for it", async () => {
    const { posted, read, send } = setup();
    await send({
      type: "synap:mutate",
      id: "m1",
      operation: "update_entity",
      payload: { id: "x", title: "pwned" },
    });
    await send({
      type: "synap:mutate",
      id: "m2",
      operation: "create_entity",
      payload: {},
    });
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual(
      ["m1", "m2"].map((id) => ({
        message: {
          type: "synap:mutate:result",
          id,
          status: "denied",
          error: CELL_BRIDGE_WRITE_REFUSED,
        },
        target: "*",
      }))
    );
  });

  it("refuses an op outside the shared table", async () => {
    const { posted, read, send } = setup();
    await send(query("entities.create", { title: "x" }));
    await send(query("apiKeys.list", {}, "q2"));
    await send(query("secrets.dump", {}, "q3"));
    expect(read).not.toHaveBeenCalled();
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        error: '"entities.create" is not something a page can read.',
      },
      {
        type: "synap:query:result",
        id: "q2",
        error: '"apiKeys.list" is not something a page can read.',
      },
      {
        type: "synap:query:result",
        id: "q3",
        error: cellBridgeUnknownOp("secrets.dump"),
      },
    ]);
  });

  it("ignores a message whose source is not the frame", async () => {
    const { posted, read, send } = setup();
    const other = fakeFrame();
    await send(query("entities.list"), other.frame);
    await send(query("entities.list"), null);
    await send(query("entities.list"), { postMessage: () => {} });
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(other.posted).toEqual([]);
  });

  it("ignores the frame once it has a real origin (it navigated away)", async () => {
    const { posted, read, send, frame } = setup();
    await send(query("entities.list"), frame, "https://evil.example");
    await send(query("entities.list"), frame, "https://pod.example");
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("ignores what is not a bridge message", async () => {
    const { posted, read, send } = setup();
    for (const data of [
      null,
      "hello",
      { type: "synap:ready" },
      { type: "synap:query" },
      { type: "not-ours", id: "x" },
      { type: "synap:query", id: "", operation: "entities.list" },
    ]) {
      await send(data);
    }
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("with no frame running, nothing is answered", async () => {
    const { posted, read, send, replaceFrame, frame } = setup();
    replaceFrame(null);
    await send(query("entities.list"), frame);
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});

describe("the page bridge host — what it answers", () => {
  it("answers an allowed op with only that op's params, to the frame", async () => {
    const { posted, read, send } = setup(async () => ({
      items: [
        {
          id: "e1",
          title: "Ship it",
          updatedAt: new Date("2026-10-27T10:00:00Z"),
        },
      ],
    }));
    await send(
      query("entities.list", {
        profileSlug: "task",
        limit: 5,
        workspaceId: "another-space",
        projectId: "a-project",
        junk: { a: 1 },
      })
    );
    expect(read).toHaveBeenCalledTimes(1);
    // The page never chooses its lens: workspaceId and projectId are no op's
    // params; a param the op does not declare is dropped too.
    expect(read).toHaveBeenCalledWith("entities.list", {
      profileSlug: "task",
      limit: 5,
    });
    expect(posted).toEqual([
      {
        message: {
          type: "synap:query:result",
          id: "q1",
          // Plain JSON data: the date crossed as a string.
          data: {
            items: [
              {
                id: "e1",
                title: "Ship it",
                updatedAt: "2026-10-27T10:00:00.000Z",
              },
            ],
          },
        },
        target: "*",
      },
    ]);
  });

  it("a failed read is an error the page can show — never an empty answer", async () => {
    const { posted, send } = setup(async () => {
      throw new Error("FORBIDDEN: not yours");
    });
    await send(query("entities.get", { id: "x" }));
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: "FORBIDDEN: not yours",
    });
    expect(posted[0]!.message).not.toHaveProperty("data");
  });

  it("a failure that is not an Error, or has no words, still reaches the page as one", async () => {
    const { posted, send } = setup(async (op) => {
      if (op === "views.list") throw "not an Error";
      throw new Error("   ");
    });
    await send(query("views.list"));
    await send(query("entities.list", {}, "q2"));
    expect(posted.map((p) => p.message)).toEqual([
      { type: "synap:query:result", id: "q1", error: "The read failed." },
      { type: "synap:query:result", id: "q2", error: "The read failed." },
    ]);
  });

  it("an over-long failure is cut to 300 characters, and says it was cut", async () => {
    const { posted, send } = setup(async () => {
      throw new Error(`refused: ${"x".repeat(400)}`);
    });
    await send(query("profiles.list"));
    const error = String(posted[0]!.message.error);
    expect(error).toHaveLength(300);
    expect(error.startsWith("refused: xxx")).toBe(true);
    expect(error.endsWith("…")).toBe(true);
  });

  it("an answer too large to hand over is an error, never a cut list", async () => {
    const { posted, send } = setup(async () => ({
      text: "x".repeat(CELL_BRIDGE_MAX_ANSWER_CHARS),
    }));
    await send(query("documents.get", { documentId: "d" }));
    expect(posted[0]!.message).toMatchObject({
      type: "synap:query:result",
      id: "q1",
    });
    expect(String(posted[0]!.message.error)).toContain("too large");
    expect(posted[0]!.message).not.toHaveProperty("data");
  });

  it("an answer for a frame that was reloaded meanwhile is dropped", async () => {
    let finish: (v: unknown) => void = () => {};
    const { posted, send, replaceFrame } = setup(
      () => new Promise((resolve) => (finish = resolve))
    );
    const pending = send(query("entities.list"));
    replaceFrame(fakeFrame().frame);
    finish({ items: [] });
    await pending;
    expect(posted).toEqual([]);
  });

  it("does not answer a frame that was replaced while the read ran", async () => {
    const first = fakeFrame();
    let current: CellBridgeTarget | null = first.frame;
    const host = createCellBridgeHost({
      frameWindow: () => current,
      read: async () => {
        current = fakeFrame().frame;
        return [];
      },
    });
    await host({
      source: first.frame,
      origin: "null",
      data: query("entities.list"),
    });
    expect(first.posted).toEqual([]);
  });

  it(`caps reads in flight at ${CELL_BRIDGE_MAX_IN_FLIGHT}`, async () => {
    const waiting: Array<(v: unknown) => void> = [];
    const { posted, read, send } = setup(
      () => new Promise((resolve) => waiting.push(resolve))
    );
    const sent = Array.from({ length: CELL_BRIDGE_MAX_IN_FLIGHT + 1 }, (_, i) =>
      send(query("views.list", {}, `q${i}`))
    );
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(CELL_BRIDGE_MAX_IN_FLIGHT);
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: `q${CELL_BRIDGE_MAX_IN_FLIGHT}`,
        error: "Too many reads at once. Wait for the others to finish.",
      },
    ]);
    waiting.forEach((resolve) => resolve([]));
    await Promise.all(sent);
    expect(posted).toHaveLength(CELL_BRIDGE_MAX_IN_FLIGHT + 1);
  });
});

describe("cellBridgeAnswer — what crosses into the page", () => {
  it("an answer is plain JSON; one too large to hand over is an error", () => {
    const at = new Date("2026-11-09T00:00:00.000Z");
    expect(cellBridgeAnswer("a", { at })).toEqual({
      type: "synap:query:result",
      id: "a",
      data: { at: at.toISOString() },
    });
    const big = cellBridgeAnswer("b", "x".repeat(1_000_001));
    expect(big).toMatchObject({ type: "synap:query:result", id: "b" });
    expect((big as { error?: string }).error).toMatch(/too large/);
    expect(big).not.toHaveProperty("data");
  });

  it("no answer crosses as null; the cap counts the JSON text, quotes included", () => {
    expect(cellBridgeAnswer("u", undefined)).toEqual({
      type: "synap:query:result",
      id: "u",
      data: null,
    });
    // A string of exactly the cap is two characters over it once quoted.
    const atCap = cellBridgeAnswer(
      "z",
      "w".repeat(CELL_BRIDGE_MAX_ANSWER_CHARS)
    );
    expect(atCap).not.toHaveProperty("data");
    expect((atCap as { error?: string }).error).toMatch(/too large/);
    const under = cellBridgeAnswer(
      "v",
      "w".repeat(CELL_BRIDGE_MAX_ANSWER_CHARS - 2)
    );
    expect(under).toHaveProperty("data");
  });
});
