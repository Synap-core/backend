/**
 * The seam of the hub SSE relay (plan P6): which way setupEventBroadcasting's
 * first hook sends an appended event. A worker (`stream: "relay"`) NOTIFYs the
 * API and broadcasts nothing locally; every other process broadcasts locally,
 * as before. Drives the real setup through the hooks it registers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks: Array<(e: unknown) => unknown> = [];
const broadcast = vi.fn();
const publish = vi.fn(async () => undefined);

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  eventRepository: {
    addEventHook: (h: (e: unknown) => unknown) => hooks.push(h),
  },
}));
vi.mock("./event-stream-manager.js", () => ({
  eventStreamManager: { broadcast },
}));
vi.mock("./utils/event-stream-relay.js", () => ({
  publishEventToStream: publish,
}));
vi.mock("./routers/entities/helpers.js", () => ({
  registerFacetAttachEmitter: () => undefined,
}));

const event = { id: "e1", eventType: "entity.create.completed" };

afterEach(() => {
  hooks.length = 0;
  broadcast.mockClear();
  publish.mockClear();
  vi.resetModules();
});

async function firstHook(opts?: { stream?: "local" | "relay" }) {
  const { setupEventBroadcasting } =
    await import("./setup-event-broadcasting.js");
  setupEventBroadcasting(opts);
  expect(hooks.length).toBeGreaterThan(0);
  return hooks[0]!;
}

describe("setupEventBroadcasting's stream hook", () => {
  it("relay (a worker): NOTIFYs the API, broadcasts nothing locally", async () => {
    await (
      await firstHook({ stream: "relay" })
    )(event);
    expect(publish).toHaveBeenCalledWith(event);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("default (all, api): broadcasts locally, NOTIFYs nothing", async () => {
    await (
      await firstHook()
    )(event);
    expect(broadcast).toHaveBeenCalledWith(event);
    expect(publish).not.toHaveBeenCalled();
  });
});
