/**
 * Hub Protocol REST — a computer's WAKER (plan v2 slice 4; finding 252fef7b).
 *
 *   GET /computers/me/wakes   → { computer, wakesAgents, leaseMs, agents[], unreadable[] }
 *
 * WHO MAY CALL: a COMPUTER (`users.agent_type = 'machine'`, the device-flow
 * key) of its own person, like `/box-runs/*`. Any other caller is refused
 * before a row is read.
 *
 * THE CALL IS THE LEASE: every read stamps the computer's key as its waker
 * (`X-Synap-Runner: synap-waker/<v>`, the per-key stamp `worker-served.ts`
 * owns), BEFORE the roster is read, so the answer already counts this waker
 * `online` (`computer-waker.ts`, {@link WAKE_LEASE_MS}).
 *
 * WHAT IT ANSWERS: the agents on THIS computer that THE wake rule reads
 * `can_wake` (the hand-off roster, `readAgentsForHandoff`, no second
 * derivation) AND that have work handed to them (orient's `handedToYou`, the
 * same read an agent's own orient makes). The waker starts each one's worker;
 * it decides nothing here. With the "Wakes agents" switch off the list is
 * empty and says so (`wakesAgents: false`): the switch is the person's.
 *
 * Checks a hub scope (`hub-protocol.read`, every computer key holds it) and,
 * because the poll stamps the key (`apiKeys.workerServedAt`), refuses a
 * stale device session like every Hub door that writes a key row. A scoped
 * (grant) key is refused by the fence (`grant-door-fence.ts`): no grant makes
 * a key a computer's waker. In the OpenAPI reference as a stub: a machine
 * protocol, not an agent-facing tool.
 */

import { and, db, eq } from "@synap/database";
import { users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  hasScope,
  logger,
  refuseStaleDeviceSession,
  type HubHono,
} from "./_shared.js";
import { registerStub } from "./_codecs/_register.js";
import { readAgentsForHandoff } from "../../../services/agent-dispatch/agents-for-handoff.js";
import { readHandedToYou } from "../../../services/discover/start-here.js";
import {
  WAKE_LEASE_MS,
  wakesAgentsOf,
} from "../../../services/computer-waker.js";
import {
  RUNNER_HEADER,
  WAKER_RUNNER,
  recordWorkerServed,
  workerRunnerVersion,
} from "../../../services/worker-served.js";

export function registerComputerWakesRoutes(app: HubHono): void {
  registerStub(app, {
    method: "get",
    path: "/computers/me/wakes",
    tags: ["Computers"],
    summary: "Which agents this computer's waker starts now",
    description:
      "A connected computer's own key only (the device-flow key). Each call is the waker's poll and stamps its lease. Answers the agents on this computer that can wake and have work handed to them; an empty list with `wakesAgents: false` while the person's \"Wakes agents\" switch is off.",
  });
  app.get("/computers/me/wakes", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        {
          code: "SCOPE_REQUIRED",
          error: "Insufficient scope: hub-protocol.read required",
        },
        403
      );
    }
    const agentUserId = c.get("agentUserId") as string | undefined;
    const userId = c.get("userId") as string | undefined;
    const keyId = c.get("apiKeyId") as string | undefined;
    if (!userId || !keyId) {
      return c.json({ code: "UNAUTHORIZED", error: "Unauthorized" }, 401);
    }
    const [machine] = agentUserId
      ? await db
          .select({
            id: users.id,
            name: users.name,
            owner: users.createdByUserId,
            meta: users.agentMetadata,
          })
          .from(users)
          .where(
            and(
              eq(users.id, agentUserId),
              eq(users.agentType, MACHINE_AGENT_TYPE)
            )
          )
          .limit(1)
      : [];
    if (!machine || !machine.owner || machine.owner !== userId) {
      return c.json(
        {
          code: "NOT_A_COMPUTER",
          error:
            "Only a connected computer's own key reads which agents to wake.",
        },
        403
      );
    }

    // The lease first: this read is the waker's poll. Its own version when
    // it says one; the read itself names it the waker either way.
    const header = c.req.header(RUNNER_HEADER);
    const said =
      header &&
      header.trim().startsWith(`${WAKER_RUNNER}`) &&
      workerRunnerVersion(header) !== undefined
        ? header
        : WAKER_RUNNER;
    await recordWorkerServed(keyId, said);

    const wakesAgents = wakesAgentsOf(machine.meta);
    const computer = { id: machine.id, name: machine.name ?? null };
    if (!wakesAgents) {
      return c.json({
        computer,
        wakesAgents: false,
        leaseMs: WAKE_LEASE_MS,
        agents: [],
        unreadable: [],
        why: 'Turn on "Wakes agents" for this computer in pod admin › Computers.',
      });
    }

    let roster;
    try {
      roster = await readAgentsForHandoff(machine.owner);
    } catch (err) {
      logger.warn(
        { err, machineId: machine.id },
        "computer wakes: roster unreadable"
      );
      return c.json(
        {
          code: "ROSTER_UNAVAILABLE",
          error: "The agents could not be read. Try again.",
        },
        503
      );
    }
    const mine = roster.agents.filter(
      (a) =>
        a.computer?.agentUserId === machine.id && a.wake.state === "can_wake"
    );
    const agents = [];
    const unreadable: string[] = [];
    for (const a of mine) {
      const handed = await readHandedToYou(machine.owner, a.agentUserId);
      if (!("items" in handed)) {
        // "unavailable" is a failed read, said; "paused" / "bound" cannot be
        // can_wake (the roster already refused them), so they never land here.
        if (handed.status === "unavailable") unreadable.push(a.agentUserId);
        continue;
      }
      if (handed.items.length === 0) continue;
      agents.push({
        agentUserId: a.agentUserId,
        name: a.name,
        agentType: a.agentType,
        template: a.template,
        wake: a.wake,
        sessions: handed.items.map((s) => ({
          id: s.id,
          ...("resume" in s && s.resume ? { resume: true } : {}),
        })),
      });
    }
    return c.json({
      computer,
      wakesAgents: true,
      leaseMs: WAKE_LEASE_MS,
      agents,
      unreadable,
    });
  });
}
