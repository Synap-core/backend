/**
 * Every isolated-vm host bridge is bound to the run's async context — proven
 * WITHOUT the native addon, so it runs on every runner.
 *
 * isolated-vm calls an `ivm.Reference` host callback with NO async context
 * (ticket f47609a6, pod knowledge 11dc561a). Here `isolated-vm` is a recorder:
 * its `Reference` keeps each bridge function `runIsolate` hands it, and its
 * script `run` calls the `__getEntities` bridge from a FOREIGN async scope
 * (an `AsyncResource` made at load time, outside every store) — the shape of
 * the native callback. The real-isolate twin is
 * `run-skill-in-sandbox.async-context.real-isolate.test.ts` (devbox only).
 *
 * Negative control (2026-10-25, branch negctl/tickets-1025-6):
 * `bindHostCallback` returning `fn` unbound turns the bridge case red (the
 * recorder reads `undefined` and no bridge carries `asyncResource`).
 */
import { AsyncResource } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    refs: new Map<string, (...args: unknown[]) => unknown>(),
    built: [] as Array<(...args: unknown[]) => unknown>,
  };
});

/** A callback scope outside every AsyncLocalStorage store, like the addon's. */
const foreignScope = new AsyncResource("isolated-vm-native-callback");

vi.mock("isolated-vm", () => {
  class Reference {
    constructor(public fn: (...args: unknown[]) => unknown) {
      h.built.push(fn);
    }
  }
  class ExternalCopy {
    constructor(private value: unknown) {}
    copyInto() {
      return this.value;
    }
  }
  class Isolate {
    isDisposed = false;
    async createContext() {
      return {
        global: {
          set: async (name: string, value: unknown) => {
            if (value instanceof Reference) h.refs.set(name, value.fn);
          },
        },
        eval: async () => undefined,
      };
    }
    async compileScript() {
      return {
        // The skill `return await hubProtocol.getEntities({...})`, as the
        // addon runs it: the host callback fires in a foreign scope.
        run: async () =>
          foreignScope.runInAsyncScope(() =>
            h.refs.get("__getEntities")!({ profileSlug: "task" })
          ),
      };
    }
    dispose() {
      this.isDisposed = true;
    }
  }
  const ivm = { Reference, ExternalCopy, Isolate };
  return { default: ivm, ...ivm };
});

import { getActingAgentUserId, runWithActingAgent } from "@synap/database";
import { bindHostCallback, runIsolate } from "./run-skill-in-sandbox.js";

describe("run-skill-in-sandbox: bridges keep the async context (no addon)", () => {
  it("the foreign scope really loses the store (non-vacuity of the harness)", async () => {
    const read = await runWithActingAgent("agent-7", async () =>
      foreignScope.runInAsyncScope(() => getActingAgentUserId())
    );
    expect(read).toBeUndefined();
  });

  it("a bridge called from that scope still sees the acting agent, and EVERY bridge is bound", async () => {
    h.refs.clear();
    h.built.length = 0;
    const seen: Array<string | undefined> = [];
    const caller = {
      entities: {
        getEntities: async () => {
          seen.push(getActingAgentUserId());
          return { entities: [] };
        },
      },
    };
    await runWithActingAgent("agent-7", () =>
      runIsolate({
        code: "return 1;",
        args: {},
        context: { userId: "u-1", workspaceId: null, agentUserId: "agent-7" },
        timeoutMs: 5000,
        allowedHosts: [],
        operatorUserId: "u-1",
        workspaceId: null,
        agentUserId: "agent-7",
        caller: caller as never,
        failureSink: {},
      })
    );
    expect(seen).toEqual(["agent-7"]);
    // DERIVED from what the run actually built: every Reference received a
    // function bound by AsyncResource.bind (it carries `asyncResource`).
    expect(h.built.length).toBeGreaterThanOrEqual(8);
    for (const fn of h.built) {
      expect(
        (fn as { asyncResource?: unknown }).asyncResource,
        fn.name || "bridge"
      ).toBeInstanceOf(AsyncResource);
    }
  });

  it("bindHostCallback keeps arguments and the return value", () => {
    const bound = bindHostCallback((a: number, b: number) => a + b);
    expect(bound(2, 3)).toBe(5);
  });
});
