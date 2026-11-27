/**
 * The verbs of one Surfaces row, driven from the wire shape
 * `surfaces.forObject` answers through the real `surfaceListRows` and the
 * real `useSurfaceRowActions`, against a tRPC client that records which door
 * was called with what:
 *
 * - Detach is offered only for an attachment read from the `attaches` links
 *   (the edge `surfaces.detach` removes), and sends that surface under its
 *   stored type; a row a legacy store lists as attached gets no Detach.
 * - Each answer is said as it is: `detached`, `proposed` (never "done"),
 *   `absent`; a failure says it failed; the list is read again.
 * - Copy link copies the row's absolute address, and never says "copied"
 *   when the clipboard refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

const h = vi.hoisted(() => ({
  calls: [] as unknown[],
  invalidated: [] as unknown[],
  toasts: [] as Array<{ title: string; color?: string }>,
  answer: { status: "detached" } as unknown,
  fail: false,
}));

vi.mock("@heroui/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heroui/react")>()),
  addToast: (t: { title: string; color?: string }) => h.toasts.push(t),
}));

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      surfaces: {
        forObject: { invalidate: (i: unknown) => h.invalidated.push(i) },
      },
    }),
    surfaces: {
      detach: {
        useMutation: () => ({
          isPending: false,
          mutate: (
            input: unknown,
            cb: {
              onSuccess?: (a: unknown) => void;
              onError?: (e: unknown) => void;
              onSettled?: () => void;
            }
          ) => {
            h.calls.push(input);
            if (h.fail) cb.onError?.(new Error("boom"));
            else cb.onSuccess?.(h.answer);
            cb.onSettled?.();
          },
        }),
      },
    },
  },
}));

import { useSurfaceRowActions } from "./surfaces-row-actions";
import {
  detachableSurface,
  surfaceListRows,
  surfaceRowLink,
} from "./surfaces-model";
import type { SurfaceRow } from "@synap-core/types/surfaces";

const E = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const S = "11111111-2222-4333-8444-555555555555";
const anchor = { kind: "entity" as const, id: E };
const wire = (over: Partial<SurfaceRow>): SurfaceRow => ({
  id: S,
  body: "view",
  relation: "attached",
  anchor,
  title: "Investor radar",
  openUrl: `/open/entity/${E}?surface=${S}`,
  readOnly: false,
  source: "attaches",
  ...over,
});
const listed = (over: Partial<SurfaceRow>) =>
  surfaceListRows([wire(over)], anchor, (k, id) => `/open/${k}/${id}`)[0]!;

function actions() {
  let api: ReturnType<typeof useSurfaceRowActions> | undefined;
  function Harness() {
    api = useSurfaceRowActions(anchor);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return api!;
}

beforeEach(() => {
  setAmbientCatalogLocale("en");
  h.calls.length = 0;
  h.invalidated.length = 0;
  h.toasts.length = 0;
  h.answer = { status: "detached" };
  h.fail = false;
});

describe("which rows Detach is offered on", () => {
  it("an attachment from the attaches links, under its stored type", () => {
    expect(detachableSurface(wire({}))).toEqual({ type: "view", id: S });
    expect(detachableSurface(wire({ body: "bento" }))).toEqual({
      type: "view",
      id: S,
    });
    expect(detachableSurface(wire({ body: "html" }))).toEqual({
      type: "document",
      id: S,
    });
    expect(detachableSurface(wire({ body: "cell" }))).toEqual({
      type: "cell_instance",
      id: S,
    });
  });

  it("never a row the door cannot take off", () => {
    // Pinned, a home, a session output: not attached.
    expect(detachableSurface(wire({ relation: "pinned" }))).toBeNull();
    expect(detachableSurface(wire({ relation: "home" }))).toBeNull();
    // Listed as attached by a legacy store: no attaches edge to remove.
    expect(
      detachableSurface(wire({ body: "cell", source: "cell-relations" }))
    ).toBeNull();
    expect(detachableSurface(wire({ source: "views" }))).toBeNull();
  });

  it("reaches the listed row", () => {
    expect(listed({}).detach).toEqual({ type: "view", id: S });
    expect(
      listed({ relation: "pinned", openUrl: `/open/${S}` }).detach
    ).toBeNull();
  });
});

describe("Detach", () => {
  it("sends this object and the surface to the one door, says it, and reads the list again", () => {
    actions().detach(listed({}), "Investor radar");
    expect(h.calls).toEqual([
      { anchor: { kind: "entity", id: E }, surface: { type: "view", id: S } },
    ]);
    expect(h.toasts).toEqual([
      {
        title: "Investor radar detached. The surface itself stays.",
        color: "default",
      },
    ]);
    expect(h.invalidated).toEqual([{ kind: "entity", id: E }]);
  });

  it("a proposal is said as sent for approval, never as done", () => {
    h.answer = { status: "proposed", proposalId: "p1" };
    actions().detach(listed({}), "Investor radar");
    expect(h.toasts[0]!.title).toBe(
      "Sent for approval: detach Investor radar."
    );
  });

  it("nothing left to take off is said as such", () => {
    h.answer = { status: "absent" };
    actions().detach(listed({}), "Investor radar");
    expect(h.toasts[0]!.title).toBe(
      "Investor radar was no longer attached here."
    );
  });

  it("a failure says it failed, and the list is still read again", () => {
    h.fail = true;
    actions().detach(listed({}), "Investor radar");
    expect(h.toasts).toEqual([
      { title: "Couldn’t detach Investor radar.", color: "danger" },
    ]);
    expect(h.invalidated).toHaveLength(1);
  });

  it("does nothing for a row it is not offered on", () => {
    actions().detach(
      listed({ relation: "pinned", openUrl: `/open/${S}` }),
      "Investor radar"
    );
    expect(h.calls).toEqual([]);
  });
});

describe("Copy link", () => {
  it("is the row's absolute address", () => {
    const row = listed({});
    expect(surfaceRowLink(row, "https://pod.example")).toBe(
      `https://pod.example/open/entity/${E}?surface=${S}`
    );
    expect(
      surfaceRowLink(
        { href: null, external: "https://app.example/x" },
        "https://pod.example"
      )
    ).toBe("https://app.example/x");
  });

  it("says copied only when the clipboard took it", async () => {
    const writes: string[] = [];
    vi.stubGlobal("window", { location: { origin: "https://pod.example" } });
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async (s: string) => void writes.push(s) },
    });
    await actions().copyLink(listed({}));
    expect(writes).toEqual([
      `https://pod.example/open/entity/${E}?surface=${S}`,
    ]);
    expect(h.toasts).toEqual([{ title: "Link copied", color: "default" }]);

    h.toasts.length = 0;
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await actions().copyLink(listed({}));
    expect(h.toasts).toEqual([
      { title: "Couldn’t copy the link", color: "danger" },
    ]);
    vi.unstubAllGlobals();
  });
});
