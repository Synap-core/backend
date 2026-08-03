import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  describeISEmptyGeneration,
  isRetryableError,
  type ISCallContext,
} from "@synap/intelligence-client";
import {
  REPORT_AUTOMATION_FLOW,
  type NodeErrorHandling,
  type AutomationNode,
  type AutomationEdge,
} from "@synap/database";
import {
  decideStepRetry,
  assessNodeRetrySafety,
} from "../automation-executor.js";

/**
 * Per-step RETRY POLICY — the pairing that makes `errorHandling.maxRetries`
 * safe to turn on.
 *
 * The production failure this pins (run of 2026-08-03 15:26): two `ai.generate`
 * steps failed with `finishReason=length · completionTokens=701 ·
 * maxTokens=700`, each after exactly ONE attempt. Turning on `maxRetries`
 * without teaching the loop about error types would have made that run WORSE,
 * not better — the same prompt at the same ceiling truncates identically, so the
 * retries buy 3× the tokens and 3× the latency for the same error.
 *
 * `decideStepRetry` is the exact decision the executor's attempt loop makes; the
 * loop simulations below drive it the way the loop does (call per caught error,
 * `attempt` = the 0-based index of the attempt that just failed) and count real
 * attempts.
 */

const ctx = (): ISCallContext => ({
  kind: "generation",
  endpoint: "https://is.example/v1/tools/generate",
  payloadChars: 15_917,
  startedAt: Date.now() - 10_100,
  budgetMs: 180_000,
});

/** The literal error the 2026-08-03 `analyze` step produced. */
const theIncidentError = () =>
  describeISEmptyGeneration(ctx(), {
    outputType: "string",
    maxTokens: 700,
    finishReason: "length",
    completionTokens: 701,
  });

describe("isRetryableError — the producer declares terminality", () => {
  it("marks a `finishReason=length` empty generation NON-retryable (deterministic truncation)", () => {
    expect(isRetryableError(theIncidentError())).toBe(false);
  });

  it("keeps an empty generation with any OTHER finish reason retryable", () => {
    for (const finishReason of ["stop", "content-filter", "error"]) {
      const err = describeISEmptyGeneration(ctx(), {
        outputType: "string",
        maxTokens: 2000,
        finishReason,
        completionTokens: 0,
      });
      expect(
        isRetryableError(err),
        `finishReason=${finishReason} must stay retryable`
      ).toBe(true);
    }
  });

  it("keeps an empty generation from a pre-seam IS (no finishReason) retryable", () => {
    const err = describeISEmptyGeneration(ctx(), {
      outputType: "string",
      maxTokens: 2000,
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it("DEFAULTS to retryable for everything it does not recognise", () => {
    // The Temporal/Restate/Inngest shape: an unknown failure is transient until
    // a producer says otherwise. A pod-side abort, an IS 5xx and a raw transport
    // error all land here.
    expect(isRetryableError(new Error("The operation was aborted"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 503 Service Unavailable"))).toBe(
      true
    );
    expect(isRetryableError("a string, not an Error")).toBe(true);
    expect(isRetryableError(null)).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
  });

  it("stamps the terminal marker on the error OBJECT, not only in the message", () => {
    // The two channels are INDEPENDENT on purpose: the marker is what the
    // builtin `ai.generate` path carries (the original Error object is
    // rethrown), the message is the fallback for a rebuild hop. Blank the
    // message so only the marker can answer.
    const err = theIncidentError();
    Object.defineProperty(err, "message", { value: "opaque", writable: true });
    expect(err.message).toBe("opaque");
    expect(isRetryableError(err)).toBe(false);
  });

  it("survives a MESSAGE-ONLY rebuild hop (executeCapabilityNode's kind:'error')", () => {
    // `executeCapabilityNode` rebuilds a dispatch verdict as
    // `new Error(\`Capability ${verbId} failed: ${message}\`)` — the marker
    // property is gone, only the attributed message survives.
    const rebuilt = new Error(
      `Capability ai.generate failed: ${theIncidentError().message}`
    );
    expect(isRetryableError(rebuilt)).toBe(false);
  });

  it("does NOT catch a `length` finish reason on a SUCCESSFUL-shaped message", () => {
    // Both halves of the signature are required, so an unrelated message that
    // merely mentions one of them is not silently made terminal.
    expect(isRetryableError(new Error("finishReason=length"))).toBe(true);
    expect(isRetryableError(new Error("[empty completion]"))).toBe(true);
  });
});

describe("decideStepRetry — the executor's attempt-loop decision", () => {
  it("stops on a non-retryable error even with attempts remaining", () => {
    expect(decideStepRetry(theIncidentError(), 0, 3)).toEqual({
      retry: false,
      reason: "non-retryable",
    });
  });

  it("retries a transient error while attempts remain", () => {
    expect(decideStepRetry(new Error("ECONNRESET"), 0, 1)).toEqual({
      retry: true,
    });
  });

  it("distinguishes exhaustion from terminality", () => {
    expect(decideStepRetry(new Error("ECONNRESET"), 1, 1)).toEqual({
      retry: false,
      reason: "attempts-exhausted",
    });
  });

  it("is a no-op when maxRetries is 0 (today's default)", () => {
    expect(decideStepRetry(new Error("ECONNRESET"), 0, 0)).toEqual({
      retry: false,
      reason: "attempts-exhausted",
    });
  });
});

/**
 * Drive `decideStepRetry` exactly as the executor's loop does and count the
 * attempts that actually happen. `maxRetries: 1` is the report automation's v15
 * setting for its four `ai.generate` nodes.
 */
function runAttemptLoop(
  maxRetries: number,
  attemptFn: (attempt: number) => void
): { attempts: number; lastError: unknown; succeeded: boolean } {
  let attempts = 0;
  let lastError: unknown;
  let succeeded = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    try {
      attemptFn(attempt);
      succeeded = true;
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      const decision = decideStepRetry(err, attempt, maxRetries);
      if (!decision.retry && decision.reason === "non-retryable") break;
    }
  }
  return { attempts, lastError, succeeded };
}

describe("the attempt loop with the report automation's v15 policy", () => {
  it("a `length`-caused empty generation gets exactly ONE attempt", () => {
    const result = runAttemptLoop(1, () => {
      throw theIncidentError();
    });
    expect(result.attempts).toBe(1);
    expect(result.succeeded).toBe(false);
  });

  it("a transient failure IS retried up to the limit", () => {
    const result = runAttemptLoop(1, () => {
      throw new Error(
        "IS generation call failed [pod-side abort] — gave up after 180011ms of a 180000ms budget"
      );
    });
    expect(result.attempts).toBe(2);
    expect(result.succeeded).toBe(false);
  });

  it("a transient failure that clears on the second attempt succeeds", () => {
    const result = runAttemptLoop(1, (attempt) => {
      if (attempt === 0) throw new Error("HTTP 503 Service Unavailable");
    });
    expect(result.attempts).toBe(2);
    expect(result.succeeded).toBe(true);
    expect(result.lastError).toBeUndefined();
  });

  it("the non-retryable path still records the FULL attributed message", () => {
    // The executor writes `lastError.message` verbatim into
    // `automation_step_runs.error_message`. Breaking early must not truncate or
    // replace it — every field an operator needs is still there.
    const result = runAttemptLoop(1, () => {
      throw theIncidentError();
    });
    const errorMessage =
      result.lastError instanceof Error
        ? result.lastError.message
        : "Unknown error";
    expect(errorMessage).toContain("[empty completion]");
    expect(errorMessage).toContain("finishReason=length");
    expect(errorMessage).toContain("completionTokens=701");
    expect(errorMessage).toContain("maxTokens=700");
    expect(errorMessage).toContain("payloadChars=15917");
    expect(errorMessage).toContain(
      "endpoint=https://is.example/v1/tools/generate"
    );
  });
});

describe("the SHIPPED report flow carries the v15 retry policy", () => {
  // Read off the REAL exported flow — editing the seed without re-reading this
  // file cannot quietly drop the policy (the same guard shape as
  // report-flow-filter-safety.test.ts).
  const aiNodes = REPORT_AUTOMATION_FLOW.nodes.filter(
    (n) =>
      n.type === "capability" &&
      (n.data as { verbId?: string }).verbId === "ai.generate"
  );

  it("has exactly the four ai.generate rounds", () => {
    expect(aiNodes.map((n) => n.id)).toEqual([
      "analyze",
      "relate",
      "assemble",
      "summarize",
    ]);
  });

  it("gives every AI round ONE retry with a 5s pause", () => {
    for (const n of aiNodes) {
      const eh = (n.data as { errorHandling?: NodeErrorHandling })
        .errorHandling;
      expect(eh?.maxRetries, `${n.id} must declare maxRetries`).toBe(1);
      expect(eh?.retryDelay, `${n.id} must declare retryDelay`).toBe(5000);
    }
  });

  it("keeps maxRetries within what the 45-minute reaper window allows", () => {
    // REAPER_STALE_MINUTES = 45 (automation-run-reaper.ts). Worst case per node
    // is attempts × the 180s generation budget + retries × retryDelay, and the
    // four rounds run in SERIES. At maxRetries 2 the AI rounds alone would take
    // 36.7 min; at 3 they could not finish at all.
    const GENERATION_BUDGET_MS = 180_000;
    const worstCaseMs = aiNodes.reduce((sum, n) => {
      const eh =
        (n.data as { errorHandling?: NodeErrorHandling }).errorHandling ?? {};
      const retries = eh.maxRetries ?? 0;
      return (
        sum +
        (retries + 1) * GENERATION_BUDGET_MS +
        retries * (eh.retryDelay ?? 0)
      );
    }, 0);
    expect(worstCaseMs).toBeLessThan(30 * 60_000);
  });

  it("leaves the two mid rounds continueOnError and the two last fail-fast", () => {
    // The retry policy must not have quietly changed the failure semantics: a
    // failed analyze/relate is still a VISIBLE GAP; a failed assemble/summarize
    // still stops the run rather than writing a broken report.
    const eh = (id: string) =>
      (
        aiNodes.find((n) => n.id === id)!.data as {
          errorHandling?: NodeErrorHandling;
        }
      ).errorHandling;
    expect(eh("analyze")?.continueOnError).toBe(true);
    expect(eh("relate")?.continueOnError).toBe(true);
    expect(eh("assemble")?.continueOnError).toBeUndefined();
    expect(eh("summarize")?.continueOnError).toBeUndefined();
  });
});

/**
 * THE RETRY-SAFETY FLOOR — which node types may be retried at all.
 *
 * `errorHandling.maxRetries` is authored per-node in a STORED flowDefinition, so
 * the dangerous case is a user (or a future seed) turning it on over a step
 * whose effect cannot survive a second execution: the outbound/irreversible
 * nodes. `assessNodeRetrySafety` is the executor's floor — a stored config may
 * narrow the retry budget, never widen it past what the effect can survive.
 *
 * Each `safe: false` below names a mechanism that is MISSING (no receipt) or
 * derived PER ATTEMPT (decoration, not idempotency — `sub_automation`). Each
 * `safe: true` names one that exists AND is keyed on something stable across an
 * attempt.
 */
describe("assessNodeRetrySafety — the executor's retry floor", () => {
  const n = (
    type: string,
    data: Record<string, unknown> = {}
  ): AutomationNode =>
    ({
      id: `${type}-1`,
      type,
      position: { x: 0, y: 0 },
      data,
    }) as AutomationNode;

  it("REFUSES the un-receipted outbound/irreversible nodes", () => {
    const unsafe: Array<[string, AutomationNode]> = [
      ["command (IS task, no receipt)", n("command", { inputMapping: {} })],
      [
        "output/entity_create (no receipt — the retryLimit:0 incident)",
        n("output", { outputType: "entity_create", config: {} }),
      ],
      [
        "output/webhook (third-party POST, no receipt)",
        n("output", { outputType: "webhook", config: { url: "https://x/y" } }),
      ],
      [
        "output/session_update with addOutput (read-modify-APPEND)",
        n("output", {
          outputType: "session_update",
          config: { addOutput: { kind: "doc", label: "Brief" } },
        }),
      ],
      [
        "fetch with a non-GET method (outbound write)",
        n("fetch", { method: "POST", url: "https://x/y" }),
      ],
      [
        "sub_automation (child runId minted PER ATTEMPT)",
        n("sub_automation", { automationId: "a1" }),
      ],
      [
        "playbook_run (idempotent only when a subject resolves)",
        n("playbook_run", { playbookId: "p1" }),
      ],
    ];
    for (const [label, node] of unsafe) {
      const verdict = assessNodeRetrySafety(node);
      expect(verdict.safe, `${label} must NOT be retry-safe`).toBe(false);
      // The floor has to say WHY — a silent clamp is unreviewable.
      expect(
        verdict.safe === false && verdict.reason.length > 0,
        `${label} must carry a reason`
      ).toBe(true);
    }
  });

  it("ALLOWS the nodes whose idempotency key is stable across an attempt", () => {
    const safe: Array<[string, AutomationNode]> = [
      [
        "output/notification (deterministic id + onConflictDoNothing)",
        n("output", { outputType: "notification", config: { body: "hi" } }),
      ],
      [
        "output/channel_message (deterministic id + onConflictDoNothing)",
        n("output", { outputType: "channel_message", config: {} }),
      ],
      [
        "output/entity_update (re-writes the same properties)",
        n("output", { outputType: "entity_update", config: { entityId: "e" } }),
      ],
      [
        "output/relation_create (dedupe + onConflictDoNothing)",
        n("output", { outputType: "relation_create", config: {} }),
      ],
      [
        "output/facet_attach (unique index → returns the existing row)",
        n("output", { outputType: "facet_attach", config: {} }),
      ],
      [
        "output/set_state (jsonb merge of the same patch)",
        n("output", { outputType: "set_state", config: {} }),
      ],
      [
        "output/session_update WITHOUT addOutput (SETs stage/grantStatus)",
        n("output", {
          outputType: "session_update",
          config: { currentStage: "review" },
        }),
      ],
      [
        "capability (routes through the capability_run_receipts CAS)",
        n("capability", { verbId: "ai.generate" }),
      ],
      ["skill (same receipt-guarded door)", n("skill", { skillId: "s1" })],
      ["fetch with the default (GET) method", n("fetch", { url: "https://x" })],
      ["claim (CAS insert — the second conflicts)", n("claim", {})],
      ["query (read)", n("query", {})],
      ["transform (pure)", n("transform", {})],
      ["condition (pure)", n("condition", {})],
    ];
    for (const [label, node] of safe) {
      expect(
        assessNodeRetrySafety(node).safe,
        `${label} must stay retry-safe`
      ).toBe(true);
    }
  });

  it("makes a loop exactly as retry-safe as its least-safe body node", () => {
    const nodes = [
      n("loop"),
      n("output", { outputType: "notification", config: {} }),
    ] as AutomationNode[];
    nodes[0]!.id = "loop-1";
    nodes[1]!.id = "body-1";
    const edges = [
      { id: "e1", source: "loop-1", target: "body-1" },
    ] as AutomationEdge[];

    // Safe body → the loop may retry.
    expect(assessNodeRetrySafety(nodes[0]!, { nodes, edges }).safe).toBe(true);

    // Flip the SAME body node to entity_create → the loop inherits the refusal
    // (a retry re-dispatches the whole body, re-running items that succeeded).
    (nodes[1]!.data as Record<string, unknown>).outputType = "entity_create";
    const verdict = assessNodeRetrySafety(nodes[0]!, { nodes, edges });
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("body-1");
  });

  it("keeps the report automation's four AI rounds retryable (the v15 policy stays live)", () => {
    // The floor must not silently undo the shipped `maxRetries: 1` — a floor
    // that clamps the one node it was never aimed at is a regression, not a fix.
    const reportAiNodes = REPORT_AUTOMATION_FLOW.nodes.filter(
      (candidate) =>
        candidate.type === "capability" &&
        (candidate.data as { verbId?: string }).verbId === "ai.generate"
    );
    expect(reportAiNodes.length).toBe(4);
    for (const node of reportAiNodes) {
      expect(
        assessNodeRetrySafety(node as AutomationNode, {
          nodes: REPORT_AUTOMATION_FLOW.nodes as AutomationNode[],
          edges: REPORT_AUTOMATION_FLOW.edges as AutomationEdge[],
        }).safe,
        `${node.id} must remain retryable`
      ).toBe(true);
    }
  });

  /**
   * WIRING. The two assertions above prove the VERDICT; this one proves the
   * executor's attempt loop actually OBEYS it. The loop needs a DB to drive
   * end-to-end, so this reads the source — narrow on purpose: it pins the ONE
   * expression that turns the verdict into the attempt budget, so deleting the
   * floor (or reverting `maxRetries` to the raw authored value) fails here
   * rather than passing green over a live double-send.
   */
  it("is WIRED into the executor's attempt loop (not merely exported)", () => {
    const src = readFileSync(
      new URL("../automation-executor.ts", import.meta.url),
      "utf-8"
    );
    // The authored value is read into `requestedRetries` …
    expect(src).toMatch(/const requestedRetries = Math\.min\(/);
    // … the floor is consulted with the flow graph (loop bodies need it) …
    expect(src).toMatch(
      /const retrySafety = assessNodeRetrySafety\(node, \{\s*nodes: flow\.nodes,\s*edges: flow\.edges,\s*\}\);/
    );
    // … and the loop's budget is the FLOORED value, never the authored one.
    expect(src).toMatch(
      /const maxRetries = retrySafety\.safe \? requestedRetries : 0;/
    );
    // The clamp must be LOUD — a silent downgrade is unreviewable.
    expect(src).toContain("is NOT retry-safe — flooring to 0");
  });
});
