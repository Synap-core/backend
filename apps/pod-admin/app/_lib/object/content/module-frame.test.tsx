/**
 * The module frame: its isolation (exact sandbox, srcdoc only, the policy
 * first), and pod admin's wiring of the shared frame host — a message from
 * another window or origin is ignored, ready → init with the host's context,
 * a write reaches the governed door stamped by the HOST (never the frame's
 * own lens or trust), a page refuses every write, a frame with no type
 * cannot write, and a proposed write is handed to the receipt.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CELL_BRIDGE_WRITE_NEEDS_TYPE,
  CELL_BRIDGE_WRITE_REFUSED,
  CELL_MODULE_FRAME_SANDBOX,
  buildCellModuleFrameCsp,
  type CellFrameHostModules,
} from "@synap-core/types/cell-bridge";

vi.mock("../../../../lib/trpc", () => ({
  trpc: { useUtils: () => ({ client: {} }) },
}));

import {
  ModuleFrame,
  ModuleSandbox,
  createModuleFrameHost,
} from "./module-frame";
import type { BridgeClient } from "./html-bridge-reads";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const iframes = (markup: string) => markup.match(/<iframe\b[^>]*>/gi) ?? [];
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return m ? m[1]! : null;
}
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const MODULES: CellFrameHostModules = {
  react: "export default {}",
  reactDom: "export default {}",
  reactDomClient: "export function createRoot() {}",
  jsxRuntime: "export function jsx() {}",
  tokensCss: ":root { --synap-color: black; }",
};
const CARD = "export default function Card() { return null; }";
const TYPE = "cell:acme:board";
const VIEW = "22222222-2222-4222-8222-222222222222";
const ENTITY = "11111111-1111-4111-8111-111111111111";

describe("ModuleSandbox — the isolation", () => {
  const [tag] = iframes(
    html(<ModuleSandbox srcDoc="<p>x</p>" title="Board" />)
  );

  it("is one iframe whose sandbox is EXACTLY the module frame's", () => {
    expect(attr(tag!, "sandbox")).toBe(CELL_MODULE_FRAME_SANDBOX);
    expect(attr(tag!, "sandbox")).toBe("allow-scripts allow-modals");
  });

  it("never grants same-origin, forms, popups or top navigation", () => {
    const sandbox = attr(tag!, "sandbox")!.split(/\s+/);
    for (const token of [
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-top-navigation",
    ]) {
      expect(sandbox).not.toContain(token);
    }
  });

  it("delegates no permission, sends no referrer, has no src, is named", () => {
    expect(attr(tag!, "allow")).toBe("");
    expect(attr(tag!, "referrerpolicy")).toBe("no-referrer");
    expect(attr(tag!, "src")).toBeNull();
    expect(attr(tag!, "title")).toBe("Board");
  });
});

describe("ModuleFrame — what it runs", () => {
  it("runs the cell in one frame, the policy FIRST in its srcdoc", () => {
    const out = html(
      <ModuleFrame
        code={CARD}
        hostModules={MODULES}
        identity={{ typeKey: TYPE }}
        workspaceId="ws-1"
        title="Card"
      />
    );
    const frames = iframes(out);
    expect(frames).toHaveLength(1);
    expect(attr(frames[0]!, "sandbox")).toBe(CELL_MODULE_FRAME_SANDBOX);
    expect(attr(frames[0]!, "src")).toBeNull();
    const srcdoc = unescape(attr(frames[0]!, "srcdoc")!);
    const csp = `<meta http-equiv="Content-Security-Policy" content="${buildCellModuleFrameCsp([])}">`;
    expect(srcdoc.indexOf(csp)).toBeGreaterThan(0);
    // Nothing loads before the policy: it is the head's first element.
    expect(srcdoc.indexOf("<head>\n" + csp)).toBeGreaterThan(0);
    expect(srcdoc.indexOf(csp)).toBeLessThan(srcdoc.indexOf("--synap-color"));
    expect(srcdoc.indexOf(csp)).toBeLessThan(srcdoc.indexOf("<script"));
  });

  it("does not run a cell that needs the kit this bundle lacks, and says why", () => {
    const out = html(
      <ModuleFrame
        code={`import { Card } from "@synap/kit";\n${CARD}`}
        hostModules={MODULES}
        identity={{ typeKey: TYPE }}
        workspaceId="ws-1"
        title="Card"
      />
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("This view needs parts this pod doesn’t have.");
    expect(out).toContain("@synap/kit");
  });

  it("does not run a cell that loads code from the network", () => {
    const out = html(
      <ModuleFrame
        code={CARD}
        deps={{ "left-pad": "1.0.0" }}
        hostModules={MODULES}
        identity={{ typeKey: TYPE }}
        workspaceId="ws-1"
        title="Card"
      />
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("This view can’t run here.");
    expect(out).toContain("left-pad");
  });
});

// ── The host wiring, driven with a fake window and a recording client ──

type Posted = { message: Record<string, unknown> };

function harness(
  opts: {
    mechanism?: "module" | "page";
    typeKey?: string;
    answer?: unknown;
  } = {}
) {
  const posted: Posted[] = [];
  const frame = {
    postMessage: (message: unknown) =>
      posted.push({ message: message as Record<string, unknown> }),
  };
  const calls: Array<[string, unknown, unknown]> = [];
  const door = (name: string) => async (input: unknown, options?: unknown) => {
    calls.push([name, input, options]);
    return opts.answer ?? { status: "updated" };
  };
  const client = {
    entities: {
      create: { mutate: door("entities.create") },
      update: { mutate: door("entities.update") },
      delete: { mutate: door("entities.delete") },
      get: { query: door("entities.get") },
    },
    relations: { create: { mutate: door("relations.create") } },
  } as unknown as BridgeClient;
  const proposed: unknown[] = [];
  const onMessage = createModuleFrameHost({
    frameWindow: () => frame,
    client,
    lens: { workspaceId: "ws-1" },
    identity: {
      ...(opts.typeKey === undefined
        ? { typeKey: TYPE }
        : opts.typeKey
          ? { typeKey: opts.typeKey }
          : {}),
      viewId: VIEW,
      entityId: ENTITY,
    },
    theme: () => "dark",
    mechanism: opts.mechanism,
    onProposed: (r) => proposed.push(r),
  });
  const send = (data: unknown, source: unknown = frame, origin = "null") =>
    onMessage({ source, origin, data });
  return { posted, calls, proposed, send, frame };
}

const UPDATE = {
  type: "synap:mutate",
  id: "w1",
  operation: "update_entity",
  payload: {
    id: ENTITY,
    properties: { status: "done" },
    expectedStatus: "doing",
    // The frame may not choose its lens or its trust: dropped.
    workspaceId: "someone-elses-space",
    viewContext: { typeKey: "cell:evil:trusted" },
    trusted: true,
  },
};

describe("createModuleFrameHost — which messages count", () => {
  it("ignores a message from another window", async () => {
    const h = harness();
    await h.send({ type: "synap:ready" }, { postMessage: () => {} });
    await h.send(UPDATE, {});
    expect(h.posted).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("ignores a message whose origin is not the sandbox's opaque one", async () => {
    const h = harness();
    await h.send({ type: "synap:ready" }, h.frame, "https://evil.example");
    expect(h.posted).toEqual([]);
  });

  it("answers ready with init, once, carrying the host's context", async () => {
    const h = harness();
    await h.send({ type: "synap:ready" });
    await h.send({ type: "synap:ready" });
    expect(h.posted).toHaveLength(1);
    const init = h.posted[0]!.message as {
      type: string;
      context: Record<string, unknown>;
    };
    expect(init.type).toBe("synap:init");
    expect(init.context).toMatchObject({
      workspaceId: "ws-1",
      workspaceScope: { type: "workspace", workspaceId: "ws-1" },
      viewId: VIEW,
      entityId: ENTITY,
      theme: "dark",
      sdkVersion: "2",
    });
  });
});

describe("createModuleFrameHost — writes", () => {
  it("sends a write to the governed door, stamped by the host, never the frame", async () => {
    const h = harness();
    await h.send(UPDATE);
    expect(h.calls).toHaveLength(1);
    const [name, input, options] = h.calls[0]!;
    expect(name).toBe("entities.update");
    expect(input).toEqual({
      id: ENTITY,
      properties: { status: "done" },
      expectedStatus: "doing",
      source: "user",
      viewContext: { typeKey: TYPE, viewId: VIEW },
    });
    // The host's lens rides as the request's space header.
    expect(options).toEqual({ context: { workspaceId: "ws-1" } });
    expect(h.posted.at(-1)!.message).toMatchObject({
      type: "synap:mutate:result",
      id: "w1",
      status: "approved",
    });
  });

  it("a proposed write: the frame reads 'proposed', and the host gives the receipt", async () => {
    const h = harness({ answer: { status: "proposed", proposalId: "p-1" } });
    await h.send(UPDATE);
    expect(h.posted.at(-1)!.message).toMatchObject({
      type: "synap:mutate:result",
      status: "proposed",
      proposalId: "p-1",
    });
    expect(h.proposed).toEqual([{ status: "proposed", proposalId: "p-1" }]);
  });

  it("a page refuses every write, and nothing reaches the pod", async () => {
    const h = harness({ mechanism: "page" });
    await h.send(UPDATE);
    expect(h.calls).toEqual([]);
    expect(h.posted.at(-1)!.message).toMatchObject({
      type: "synap:mutate:result",
      status: "denied",
      error: CELL_BRIDGE_WRITE_REFUSED,
    });
  });

  it("a frame with no type cannot write", async () => {
    const h = harness({ typeKey: "" });
    await h.send(UPDATE);
    expect(h.calls).toEqual([]);
    expect(h.posted.at(-1)!.message).toMatchObject({
      status: "denied",
      error: CELL_BRIDGE_WRITE_NEEDS_TYPE,
    });
  });

  it("reads go through the console's read door with the host's lens", async () => {
    const h = harness();
    await h.send({
      type: "synap:query",
      id: "r1",
      operation: "entities.get",
      params: { id: ENTITY, workspaceId: "someone-elses-space" },
    });
    expect(h.calls).toEqual([["entities.get", { id: ENTITY }, undefined]]);
    expect(h.posted.at(-1)!.message).toMatchObject({
      type: "synap:query:result",
      id: "r1",
    });
  });
});
