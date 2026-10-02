/**
 * posthog-analytics — the verb layer's governance + failure behaviour.
 *
 * The dispatcher is MOCKED (it is the only I/O), so what is under test is
 * everything this capability decides: what it sends, what it forwards, what it
 * refuses, and — the load-bearing one — that a FAILED read throws instead of
 * returning an empty series. `triggerProviderAction`'s arguments are asserted
 * because two of them ARE the security posture:
 *
 *   - `provider: "posthog_api"` — the installed tool, whose `config.baseUrl`
 *     pins host + project id at install time. No host ever travels from here.
 *   - `alreadyApproved: true` — the capability gate already decided this run
 *     (the verb is in READ_ONLY_BUILTIN_VERBS), so an agent's analytics read is
 *     not re-litigated into a review proposal one frame down.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: vi.fn(),
}));

import { triggerProviderAction } from "../../connectors/external-dispatch.js";
import {
  runPostHogEventTrend,
  runPostHogStepReach,
  runPostHogTopEvents,
  runPostHogUniqueUsers,
} from "./verbs.js";
import { classifyPostHogFailure } from "./client.js";
import type { BuiltinVerbContext } from "../capabilities/builtin-verbs.js";

const mockedDispatch = vi.mocked(triggerProviderAction);

const CTX: BuiltinVerbContext = {
  userId: "user-1",
  workspaceId: null,
  agentUserId: null,
};

function dispatchReturns(result: Record<string, unknown>): void {
  mockedDispatch.mockResolvedValue(result as never);
}

function lastCall(): Record<string, unknown> {
  const call = mockedDispatch.mock.calls.at(-1)?.[0];
  if (!call) throw new Error("triggerProviderAction was never called");
  return call as unknown as Record<string, unknown>;
}

beforeEach(() => {
  mockedDispatch.mockReset();
});

describe("what the capability sends", () => {
  it("dispatches the INSTALLED tool by name, with the pinned path and alreadyApproved", async () => {
    dispatchReturns({
      success: true,
      status: 200,
      body: {
        result: [
          { label: "$pageview", count: 4, labels: ["2026-10-01"], data: [4] },
        ],
      },
    });

    const out = (await runPostHogEventTrend(
      { event: "$pageview", days: 7 },
      CTX
    )) as Record<string, unknown>;

    const call = lastCall();
    expect(call.provider).toBe("posthog_api");
    expect(call.userId).toBe("user-1");
    expect(call.method).toBe("GET");
    // A READ declared in READ_ONLY_BUILTIN_VERBS must not re-enter the tool gate.
    expect(call.alreadyApproved).toBe(true);
    // A GET carries no body.
    expect(call.body).toBeUndefined();
    // Only a relative path — the host is the tool's config.baseUrl, never ours.
    expect(String(call.path).startsWith("/insights/trend/?")).toBe(true);
    expect(String(call.path)).not.toContain("http");

    expect(out.empty).toBe(false);
    expect(out.seriesCount).toBe(1);
  });

  it("forwards the acting agent so the run is attributed, not laundered", async () => {
    dispatchReturns({ success: true, status: 200, body: { result: [] } });
    await runPostHogEventTrend(
      { event: "$pageview" },
      { ...CTX, agentUserId: "agent-9", workspaceId: "ws-1" }
    );
    const call = lastCall();
    expect(call.agentUserId).toBe("agent-9");
    expect(call.workspaceId).toBe("ws-1");
  });

  it("refuses a scope field at the verb boundary (strict params)", async () => {
    dispatchReturns({ success: true, status: 200, body: { result: [] } });
    await expect(
      runPostHogEventTrend({ event: "$pageview", projectId: 999 }, CTX)
    ).rejects.toThrow();
    // …and nothing was dispatched: the rejection happened before any credential
    // was touched.
    expect(mockedDispatch).not.toHaveBeenCalled();
  });
});

describe("an empty read is a success; a failed read is an error", () => {
  it("empty trend result → empty:true, no throw", async () => {
    dispatchReturns({ success: true, status: 200, body: { result: [] } });
    const out = (await runPostHogEventTrend(
      { event: "$pageview" },
      CTX
    )) as Record<string, unknown>;
    expect(out.empty).toBe(true);
    expect(out.seriesCount).toBe(0);
  });

  it("empty top-events table → rowCount 0, empty:true, no throw", async () => {
    dispatchReturns({
      success: true,
      status: 200,
      body: { columns: ["event", "event_count"], results: [] },
    });
    const out = (await runPostHogTopEvents({}, CTX)) as Record<string, unknown>;
    expect(out.rowCount).toBe(0);
    expect(out.empty).toBe(true);
  });

  it("all-zero step reach → empty:true, not an error", async () => {
    dispatchReturns({
      success: true,
      status: 200,
      body: { columns: ["step_1_users", "step_2_users"], results: [[0, 0]] },
    });
    const out = (await runPostHogStepReach(
      { steps: ["a", "b"] },
      CTX
    )) as Record<string, unknown>;
    expect(out.empty).toBe(true);
  });

  it("a 401 is a THROWN credential error naming the remedy — never an empty series", async () => {
    dispatchReturns({
      success: false,
      status: 401,
      errorCode: "bad_request",
      error:
        "Personal API key found in request Authorization header is invalid",
    });

    const err = await runPostHogEventTrend({ event: "$pageview" }, CTX).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(TRPCError);
    const trpc = err as TRPCError;
    // 412: a human must fix the configuration (see httpStatusForTrpcError).
    expect(trpc.code).toBe("PRECONDITION_FAILED");
    expect(trpc.message).toMatch(/PERSONAL API KEY/);
    expect(trpc.message).toMatch(/ingest-only|INGEST-ONLY/);
    expect(trpc.message).toMatch(/Personal API key found in request/);
  });

  it("a missing tool row names the capability + params to install", async () => {
    dispatchReturns({
      success: false,
      status: 404,
      errorCode: "not_found",
      error: "Tool not found for name: posthog_api",
    });
    const err = (await runPostHogTopEvents({}, CTX).catch(
      (e: unknown) => e
    )) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toMatch(/posthog-analytics/);
    expect(err.message).toMatch(/personalApiKey/);
  });

  it("a 200 with an unreadable body THROWS (a broken parse cannot read as empty)", async () => {
    dispatchReturns({ success: true, status: 200, body: { nope: true } });
    const err = (await runPostHogEventTrend({ event: "$pageview" }, CTX).catch(
      (e: unknown) => e
    )) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    // Not the caller's fault: our parse could not read what PostHog sent.
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
    expect(err.message).toMatch(/no `result` array/);
  });

  it("a 200 carrying PostHog's own error is surfaced with PostHog's words", async () => {
    dispatchReturns({
      success: true,
      status: 200,
      body: { detail: "HogQL queries are not enabled for this project" },
    });
    const err = (await runPostHogTopEvents({}, CTX).catch(
      (e: unknown) => e
    )) as TRPCError;
    expect(err.message).toMatch(/HogQL queries are not enabled/);
  });

  it("a successful response with NO body is an error, not an empty read", async () => {
    dispatchReturns({ success: true, status: 200 });
    await expect(runPostHogUniqueUsers({}, CTX)).rejects.toThrow(/no body/);
  });
});

describe("failure classification", () => {
  it("distinguishes 'we never reached PostHog' from 'PostHog said 404'", () => {
    const missingTool = classifyPostHogFailure({
      status: 404,
      errorCode: "not_found",
      error: "Tool not found for name: posthog_api",
    });
    expect(missingTool.trpcCode).toBe("PRECONDITION_FAILED");
    expect(missingTool.message).toMatch(/not configured/);

    const upstream404 = classifyPostHogFailure({
      status: 404,
      errorCode: "not_found",
      error: "Project not found",
    });
    expect(upstream404.trpcCode).toBe("NOT_FOUND");
    expect(upstream404.message).toMatch(/projectId and analyticsHost/);
  });

  it("maps each failure class to a status the door can honor", () => {
    expect(classifyPostHogFailure({ status: 403 }).trpcCode).toBe(
      "PRECONDITION_FAILED"
    );
    expect(classifyPostHogFailure({ status: 429 }).trpcCode).toBe("CONFLICT");
    expect(
      classifyPostHogFailure({ status: 400, error: "bad param" }).trpcCode
    ).toBe("BAD_REQUEST");
    expect(classifyPostHogFailure({ status: 502 }).trpcCode).toBe(
      "INTERNAL_SERVER_ERROR"
    );
    expect(classifyPostHogFailure({}).trpcCode).toBe("INTERNAL_SERVER_ERROR");
  });

  it("surfaces an unresolvable vault grant as a configuration fault", () => {
    const c = classifyPostHogFailure({
      status: 403,
      error: "Vault grant check failed: no active grant",
    });
    expect(c.trpcCode).toBe("PRECONDITION_FAILED");
    expect(c.message).toMatch(/credential could not be resolved/);
  });
});
