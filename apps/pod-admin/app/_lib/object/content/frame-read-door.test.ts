/**
 * Pod admin's page frames read through THE frame read door (Surfaces P6a):
 * a running HTML page's `synap:query` (`createPageFrameHost`, what
 * `HtmlFrame` runs) goes to `surfaces.frameRead` named as the surface the
 * frame draws, never to a procedure the console picks itself:
 *
 *   - a stored page reads as `{kind: "document", id}`, with no lens of its
 *     own (the door reads it in the page's own space);
 *   - an HTML cell reads as `{kind: "cell", typeKey}`, in the host's space;
 *   - the frame's own `workspaceId` never reaches the door;
 *   - a refusal of the door (403 FRAME_READ_UNDECLARED) reaches the page as
 *     an ERROR, never as an empty answer;
 *   - a frame whose surface the host cannot name reads nothing.
 *
 * The module frame's twin rows live in `module-frame.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { CELL_FRAME_NO_READS } from "@synap-core/types/cell-bridge";

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ client: {} }),
    surfaces: { context: { useQuery: () => ({ data: { brand: null } }) } },
  },
}));

import { createPageFrameHost } from "./html-frame";
import type { FrameSurface } from "./frame-read-door";
import type { BridgeClient } from "./html-bridge-reads";

const DOC = "11111111-1111-4111-8111-111111111111";
const REFUSED =
  'This page does not declare the read "entities.list" with these params, so the pod refuses it.';

function harness(surface: FrameSurface | null, refuse = false) {
  const posted: Record<string, unknown>[] = [];
  const frame = {
    postMessage: (message: unknown) =>
      posted.push(message as Record<string, unknown>),
  };
  const calls: Array<[string, unknown]> = [];
  const procedure =
    (name: string) =>
    async (input: unknown): Promise<unknown> => {
      calls.push([name, input]);
      if (refuse) throw new Error(REFUSED);
      return { items: [{ id: "e-1" }] };
    };
  // Every procedure the console could have picked itself is here: a read
  // that skipped the door would be recorded under its own name.
  const client = {
    surfaces: { frameRead: { query: procedure("surfaces.frameRead") } },
    entities: {
      list: { query: procedure("entities.list") },
      get: { query: procedure("entities.get") },
    },
  } as unknown as BridgeClient;
  const onMessage = createPageFrameHost({
    frameWindow: () => frame,
    client,
    surface,
    workspaceId: "ws-1",
  });
  const read = () =>
    onMessage({
      source: frame,
      origin: "null",
      data: {
        type: "synap:query",
        id: "q1",
        operation: "entities.list",
        params: { profileSlug: "deal", workspaceId: "someone-elses-space" },
      },
    });
  return { posted, calls, read };
}

describe("a page frame reads through THE frame read door", () => {
  it("a stored page reads as its document, in its own space", async () => {
    const h = harness({ kind: "document", id: DOC });
    await h.read();
    expect(h.calls).toEqual([
      [
        "surfaces.frameRead",
        {
          surface: { kind: "document", id: DOC },
          op: "entities.list",
          params: { profileSlug: "deal" },
        },
      ],
    ]);
    expect(h.posted).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        data: { items: [{ id: "e-1" }] },
      },
    ]);
  });

  it("an HTML cell reads as its type, in the host's space", async () => {
    const h = harness({ kind: "cell", typeKey: "generated:q3-report" });
    await h.read();
    expect(h.calls).toEqual([
      [
        "surfaces.frameRead",
        {
          surface: { kind: "cell", typeKey: "generated:q3-report" },
          op: "entities.list",
          params: { profileSlug: "deal" },
          workspaceId: "ws-1",
        },
      ],
    ]);
  });

  it("a read the door refuses reaches the page as an error, never as data", async () => {
    const h = harness({ kind: "document", id: DOC }, true);
    await h.read();
    expect(h.posted).toEqual([
      { type: "synap:query:result", id: "q1", error: REFUSED },
    ]);
  });

  it("a frame with no surface reads nothing: the door is never asked", async () => {
    const h = harness(null);
    await h.read();
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([
      { type: "synap:query:result", id: "q1", error: CELL_FRAME_NO_READS },
    ]);
  });
});
