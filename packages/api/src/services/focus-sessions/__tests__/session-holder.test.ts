/**
 * `deriveSessionHolder` — the one "who has it" rule, pure. Pinned: each
 * source's own word maps onto ONE wait kind (no new state set), and the
 * holder's `kind` is that word's ball:
 *   - a session that ended is held by nobody;
 *   - the external agent's status: running / pending_start / needs_input;
 *   - a live runner's state, the most urgent first, a roster agent's first;
 *     a runner that names no state is judged by the live rule;
 *   - the roster's last-added agent by the live rule on the AGENT's clock
 *     (a person's act moves `lastAt`, never `lastAgentWorkAt`);
 *   - an agent not at work, with the person's wait leading: handed back;
 *   - nobody on it: nobody (no_agent).
 * The read side (agents named, a failed read) is pinned on PGlite in
 * `session-holder.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { WaitingOnMark } from "@synap-core/types/units";
import {
  deriveSessionHolder,
  type SessionHolderFacts,
} from "../session-holder.js";
import type { SessionExternalAgent } from "../../agent-dispatch/session-external-agent.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const A = "agent-a";
const B = "agent-b";

const BASE: SessionHolderFacts = {
  session: { status: "active", agentIds: [A], expectedOutputs: [] },
  externalAgent: null,
  runners: [],
  live: {
    turnInFlight: false,
    since: null,
    lastAt: null,
    lastAgentWorkAt: null,
  },
  waitingOn: [],
  now: NOW,
};
const facts = (over: Partial<SessionHolderFacts> = {}): SessionHolderFacts => ({
  ...BASE,
  ...over,
  session: { ...BASE.session, ...over.session },
});

const runner = (
  agentUserId: string | null,
  state: "busy" | "idle" | "needs_permission" | "ended" | null,
  live = true
) => ({
  agentUserId,
  state,
  live,
  stateSince: ago(30_000),
  lastSeenAt: ago(10_000),
});

const ext = (status: SessionExternalAgent["status"]): SessionExternalAgent =>
  ({
    runId: "run-1",
    runStatus: "running",
    agentUserId: B,
    agentName: "Acme",
    provider: "acme",
    status,
    proposalId: null,
    url: null,
    prUrl: null,
    branch: null,
    previewUrl: null,
    summary: null,
    pollError: null,
    cancelStopsAgent: null,
    reportedAt: {},
    polledAt: null,
    startedAt: ago(600_000),
    lastNewsAt: ago(60_000),
    quietAfterMs: null,
  }) as SessionExternalAgent;

const owedAnswer: WaitingOnMark[] = [
  {
    reason: "input",
    count: 1,
    refs: [{ kind: "slot", label: "Pick a cover", waitKind: "answer" }],
  },
];

describe("deriveSessionHolder", () => {
  it("an ended session is held by nobody, whatever else is on it", () => {
    for (const status of ["closed", "failed", "cancelled"]) {
      const h = deriveSessionHolder(
        facts({
          session: {
            status,
            agentIds: [A],
            expectedOutputs: [],
            closedAt: ago(5_000),
          },
          runners: [runner(A, "busy")],
        })
      );
      expect(h).toMatchObject({
        kind: "nobody",
        waitKind: null,
        reason: "ended",
        agentUserId: null,
        since: ago(5_000),
        source: { from: "session", status },
      });
    }
  });

  it("the external agent's status maps onto one wait kind", () => {
    expect(
      deriveSessionHolder(facts({ externalAgent: ext("running") }))
    ).toMatchObject({
      kind: "agent",
      waitKind: "agent_work",
      agentUserId: B,
      since: ago(60_000),
      source: { from: "external_agent", status: "running" },
    });
    expect(
      deriveSessionHolder(facts({ externalAgent: ext("pending_start") }))
    ).toMatchObject({ kind: "person", waitKind: "approval", agentUserId: B });
    expect(
      deriveSessionHolder(facts({ externalAgent: ext("needs_input") }))
    ).toMatchObject({ kind: "person", waitKind: "answer", agentUserId: B });
    // A finished dispatch holds nothing: the roster decides.
    expect(
      deriveSessionHolder(facts({ externalAgent: ext("done") }))
    ).toMatchObject({
      kind: "agent",
      waitKind: "agent_stopped",
      agentUserId: A,
    });
  });

  it("a live runner's word: needs_permission over busy over idle, a roster agent's first", () => {
    expect(
      deriveSessionHolder(facts({ runners: [runner(A, "busy")] }))
    ).toMatchObject({
      kind: "agent",
      waitKind: "agent_work",
      agentUserId: A,
      since: ago(30_000),
      source: { from: "runner", state: "busy" },
    });
    expect(
      deriveSessionHolder(
        facts({ runners: [runner(A, "idle"), runner(A, "needs_permission")] })
      )
    ).toMatchObject({ kind: "person", waitKind: "approval", agentUserId: A });
    expect(
      deriveSessionHolder(facts({ runners: [runner(A, "idle")] }))
    ).toMatchObject({ kind: "agent", waitKind: "agent_stopped" });
    // B is not on the roster: A's runner holds it even though B is busier.
    expect(
      deriveSessionHolder(
        facts({ runners: [runner(B, "busy"), runner(A, "idle")] })
      )
    ).toMatchObject({ agentUserId: A, waitKind: "agent_stopped" });
    // A runner past its live window, or a person's own key, holds nothing.
    expect(
      deriveSessionHolder(
        facts({
          session: { status: "active", agentIds: [], expectedOutputs: [] },
          runners: [runner(B, "busy", false), runner(null, "busy")],
        })
      )
    ).toMatchObject({ kind: "nobody", reason: "no_agent" });
  });

  it("a runner that names no state is judged by the live rule", () => {
    expect(
      deriveSessionHolder(
        facts({
          runners: [runner(A, null)],
          live: {
            turnInFlight: false,
            since: null,
            lastAt: ago(10_000),
            lastAgentWorkAt: ago(10_000),
          },
        })
      )
    ).toMatchObject({
      kind: "agent",
      waitKind: "agent_work",
      source: { from: "live", working: true },
    });
  });

  it("the roster's last-added agent, on the agent's own clock", () => {
    const quiet = deriveSessionHolder(
      facts({
        session: { status: "active", agentIds: [B, A], expectedOutputs: [] },
        // A person approved something a minute ago; the agent last worked an hour ago.
        live: {
          turnInFlight: false,
          since: null,
          lastAt: ago(60_000),
          lastAgentWorkAt: ago(3_600_000),
        },
      })
    );
    expect(quiet).toMatchObject({
      kind: "agent",
      waitKind: "agent_stopped",
      agentUserId: A,
      since: ago(3_600_000),
      source: { from: "live", working: false },
    });
    const turn = deriveSessionHolder(
      facts({
        live: {
          turnInFlight: true,
          since: ago(20_000),
          lastAt: ago(20_000),
          lastAgentWorkAt: ago(3_600_000),
        },
      })
    );
    expect(turn).toMatchObject({
      kind: "agent",
      waitKind: "agent_work",
      since: ago(20_000),
    });
  });

  it("an agent not at work with the person's wait leading: handed back to the person", () => {
    const h = deriveSessionHolder(
      facts({
        session: {
          status: "active",
          agentIds: [A],
          expectedOutputs: [
            {
              key: "cover",
              label: "Pick a cover",
              kind: "decision",
              owner: "human",
              status: "pending",
              owedSince: ago(120_000),
            },
          ],
        },
        waitingOn: owedAnswer,
      })
    );
    expect(h).toMatchObject({
      kind: "person",
      waitKind: "answer",
      agentUserId: A,
      since: ago(120_000),
      source: { from: "waiting_on" },
    });
    // An agent at work keeps it, even with an answer owed.
    expect(
      deriveSessionHolder(
        facts({ runners: [runner(A, "busy")], waitingOn: owedAnswer })
      )
    ).toMatchObject({ kind: "agent", waitKind: "agent_work" });
  });

  it("nobody on it: nobody (no_agent), never a guess", () => {
    expect(
      deriveSessionHolder(
        facts({
          session: { status: "active", agentIds: [], expectedOutputs: [] },
        })
      )
    ).toEqual({
      kind: "nobody",
      waitKind: null,
      since: null,
      agentUserId: null,
      source: { from: "roster" },
      reason: "no_agent",
    });
  });
});
