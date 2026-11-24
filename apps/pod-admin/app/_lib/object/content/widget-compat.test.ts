import { describe, expect, it, vi } from "vitest";
import { wrapHtmlForFrame } from "@synap-core/types/cell-bridge";
import {
  PREVIEW_SAMPLE_ENTITY,
  usesWidgetHost,
  widgetCompatBlock,
  withWidgetCompat,
} from "./widget-compat";

const CARD = `<!DOCTYPE html><html><head><style>.card{color:var(--synap-foreground)}</style></head><body><div id="root">Loading…</div><script>
SynapWidget.onInit(async function (init) {
  var id = init.context && init.context.entityId;
  if (!id) { document.title = "no entity"; return; }
  var res = await SynapWidget.query('entities.get', { id: id });
  document.title = res.title;
});</script></body></html>`;

/** Run the compat script the way the frame does: a window with the bridge's `synap`. */
function runInFrame(sample: boolean) {
  const block = widgetCompatBlock({ sample });
  const source = /<script>([\s\S]*)<\/script>/.exec(block)![1]!;
  const win: Record<string, unknown> = {
    synap: { query: vi.fn(async () => ({ from: "bridge" })), mutate: vi.fn() },
  };
  new Function("window", source)(win);
  return win as {
    SynapWidget: {
      onInit: (fn: (init: unknown, ctx: unknown) => void) => void;
      query: (op: string, params?: unknown) => Promise<unknown>;
      navigate: (t: unknown) => void;
    };
    synap: { query: ReturnType<typeof vi.fn> };
  };
}

describe("the widget host a stored card calls", () => {
  it("is defined, so a card's first line no longer throws", async () => {
    const win = runInFrame(false);
    expect(typeof win.SynapWidget.onInit).toBe("function");
    expect(() =>
      win.SynapWidget.navigate({ type: "entity", id: "x" })
    ).not.toThrow();
  });

  it("calls the card's init, once, with the context the card reads", async () => {
    const win = runInFrame(true);
    const seen: unknown[] = [];
    win.SynapWidget.onInit((init, ctx) => seen.push([init, ctx]));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    const [init, ctx] = seen[0] as [
      { context: { entityId?: string } },
      unknown,
    ];
    expect(init.context.entityId).toBe(PREVIEW_SAMPLE_ENTITY.id);
    expect(ctx).toBe(init.context);
  });

  it("a preview answers entities.get from the sample and asks the bridge for nothing", async () => {
    const win = runInFrame(true);
    const got = (await win.SynapWidget.query("entities.get", {
      id: "any",
    })) as {
      title: string;
    };
    expect(got.title).toBe(PREVIEW_SAMPLE_ENTITY.title);
    expect(win.synap.query).not.toHaveBeenCalled();
  });

  it("a stored page (no sample) reads through the bridge and is given no entity", async () => {
    const win = runInFrame(false);
    const seen: Array<{ context: { entityId?: string } }> = [];
    win.SynapWidget.onInit((init) => seen.push(init as never));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]!.context.entityId).toBeUndefined();
    expect(await win.SynapWidget.query("entities.get", { id: "e1" })).toEqual({
      from: "bridge",
    });
    expect(win.synap.query).toHaveBeenCalledWith("entities.get", { id: "e1" });
  });
});

describe("withWidgetCompat — where the block goes", () => {
  it("leaves a page that does not use the widget host byte-for-byte alone", () => {
    const page = "<!doctype html><html><body><h1>Report</h1></body></html>";
    expect(usesWidgetHost(page)).toBe(false);
    expect(withWidgetCompat(page, { sample: true })).toBe(page);
  });

  it("keeps the doctype first, then the policy, the SDK, the compat block, the page", () => {
    const srcdoc = wrapHtmlForFrame(withWidgetCompat(CARD, { sample: true }), {
      links: true,
    });
    const at = (needle: string) => srcdoc.indexOf(needle);
    expect(srcdoc.startsWith("<!DOCTYPE html>")).toBe(true);
    const order = [
      at("Content-Security-Policy"),
      at("synap-cell-bridge/1"),
      at("window.SynapWidget ="),
      at("SynapWidget.onInit(async"),
    ];
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("defines the five tokens the cards draw with, in the frame", () => {
    const srcdoc = wrapHtmlForFrame(withWidgetCompat(CARD, { sample: false }), {
      links: true,
    });
    for (const token of [
      "--synap-foreground",
      "--synap-background",
      "--synap-border",
      "--synap-primary",
      "--synap-primary-foreground",
    ]) {
      expect(srcdoc).toContain(`${token}:`);
    }
  });

  it("can never close its own script from inside", () => {
    const block = widgetCompatBlock({ sample: true });
    expect(block.match(/<\/script/gi)).toHaveLength(1);
  });
});
