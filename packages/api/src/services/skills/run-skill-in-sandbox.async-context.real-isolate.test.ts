/**
 * A code skill's host bridges keep the run's async context.
 *
 * isolated-vm calls an `ivm.Reference` host callback with NO async context, so
 * every AsyncLocalStorage store reads empty inside it. On the IS twin that made
 * every in-skill `callProvider` go out without the run's delegation and come
 * back 401 (ticket f47609a6, pod knowledge 11dc561a). The pod's in-process
 * sandbox builds the same bridges; here the store that would vanish is the
 * acting agent (`runWithActingAgent`), which the write gate reads.
 *
 * Runs the REAL isolated-vm isolate (the `inline` runner) and the REAL bridge
 * code (`runIsolate`); only the hub caller is a recorder. The same case through
 * a runner PROCESS is in `runner/process-pool.real-isolate.test.ts`. Negative control (2026-10-25, branch
 * negctl/tickets-1025-5, devbox): `bindHostCallback` returning `fn` unbound
 * turns the behavioural case red (the recorder reads `undefined`).
 *
 * SKIPPED, by name, where the native addon is not built (the GitHub runner:
 * "No native build was found for platform=linux … node=20"). It runs on the
 * devbox gate tree. The addon-free guard is the sibling
 * `run-skill-in-sandbox.async-context.test.ts`, which runs everywhere.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});
import { getActingAgentUserId, runWithActingAgent } from "@synap/database";
import { runIsolate } from "./run-skill-in-sandbox.js";
import { inlineSkillRunner } from "./runner/index.js";

const ivmLoads = await import("isolated-vm").then(
  () => true,
  () => false
);

describe("run-skill-in-sandbox: bridges keep the async context", () => {
  it.skipIf(!ivmLoads)(
    "a hub read made from inside the REAL isolate still sees the acting agent (skipped where the isolated-vm native addon is not built)",
    async () => {
      const seen: Array<string | undefined> = [];
      const caller = {
        entities: {
          getEntities: async () => {
            seen.push(getActingAgentUserId());
            return { entities: [] };
          },
        },
      };
      const result = await runWithActingAgent("agent-7", () =>
        runIsolate({
          code: "return await hubProtocol.getEntities({ profileSlug: 'task' });",
          args: {},
          context: { userId: "u-1", workspaceId: null, agentUserId: "agent-7" },
          timeoutMs: 5000,
          allowedHosts: [],
          operatorUserId: "u-1",
          workspaceId: null,
          agentUserId: "agent-7",
          caller: caller as never,
          failureSink: {},
          runner: inlineSkillRunner,
        })
      );
      // Non-vacuity: the bridge really ran, once.
      expect(result).toEqual({ entities: [] });
      expect(seen).toEqual(["agent-7"]);
    }
  );
});
