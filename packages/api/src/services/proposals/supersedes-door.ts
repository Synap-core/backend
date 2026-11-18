/**
 * The ONE `supersedes` door (plan 8032a127 D3): a filing that REPLACES a
 * failed proposal names it, and the proposal it files ends the failed one
 * (`withdrawn` + `supersededBy`, in the insert's transaction:
 * `insertPendingProposal`). The person keeps ONE request, never an orphaned
 * failure beside its fix.
 *
 * Two doors take it, and both call this file, never a copy of it:
 *  - MCP, on the tools of {@link SUPERSEDES_DOORS} (`routers/mcp/adapter.ts`);
 *  - Hub REST, on the same doors' routes (`hub-protocol/_middleware/
 *    supersedes.ts`), which is how the Intelligence Service files: it reaches
 *    the pod only through Hub REST, and Ask AI wakes it on another agent's
 *    failed proposal (finding d6ac7003).
 * The checks themselves (same person, failed, no partly-applied plan, and the
 * same request) live once, in `supersedesProblem` (`@synap/database`): the
 * door runs it before the route, and the insert door again against the row
 * it files, with that row's request.
 */
import {
  runWithSupersedes,
  supersedesProblem,
  SupersedesRefusedError,
  type SupersedesSlot,
} from "@synap/database";

/**
 * The doors that take `supersedes`: the MCP tool and the Hub REST route that
 * file the same request. ONLY the doors that filed the founder's 44 failures
 * (17 Nov 2026): a capability run (LinkedIn sends go through it), an entity
 * create or update, a capture graph. Not every write door: one property on
 * ~80 MCP tools broke the `token-budget` ratchet (decision of 17 Nov 2026,
 * option A). An MCP tool is added here WITH its Hub route, so the two doors
 * never disagree on what can replace a failed proposal.
 */
export const SUPERSEDES_DOORS = [
  {
    tool: "synap_run_capability",
    method: "POST",
    route: "/capabilities/execute",
  },
  { tool: "synap_create_entity", method: "POST", route: "/entities" },
  {
    tool: "synap_update_entity",
    method: "PATCH",
    route: "/entities/:entityId",
  },
  { tool: "synap_capture", method: "POST", route: "/capture/graph" },
] as const satisfies readonly {
  tool: string;
  method: "POST" | "PATCH";
  route: string;
}[];

/** What a door received as `supersedes`: nothing, an id, or a refusal. */
export type SupersedesRead =
  { ok: true; id: string | undefined } | { ok: false; problem: string };

/** Read the `supersedes` a caller sent (blank = not sent). */
export function readSupersedes(raw: unknown): SupersedesRead {
  if (raw === undefined || raw === null) return { ok: true, id: undefined };
  if (typeof raw !== "string") {
    return {
      ok: false,
      problem:
        "`supersedes` must be the id of the failed proposal this request replaces. Nothing was filed.",
    };
  }
  const id = raw.trim();
  return { ok: true, id: id === "" ? undefined : id };
}

/** A filing run under `supersedes`. */
export type SupersedingRun<T> =
  /** The name cannot be replaced: nothing was filed. */
  | { refused: string }
  /** The filing ran; `slot` says whether it replaced the failed proposal. */
  | { refused: null; result: T; slot: SupersedesSlot | null };

/**
 * Run `file` as a filing that replaces `supersedes` (when named), for the
 * person `ownerUserId` the filing acts for. Refused BEFORE `file` runs when
 * the name cannot be replaced, so a wrong name files nothing. Refused too
 * when the insert door refused the row `file` filed as another request than
 * the failed one (`supersedesProblem` with the request): whatever the route
 * made of that throw (re-thrown, or answered as its own error), the door
 * answers the refusal, so every door says SUPERSEDES_REFUSED alike.
 */
export async function fileSuperseding<T>(
  supersedes: string | undefined,
  ownerUserId: string | null,
  file: () => Promise<T>
): Promise<SupersedingRun<T>> {
  if (!supersedes) return { refused: null, result: await file(), slot: null };
  const problem = await supersedesProblem(supersedes, ownerUserId);
  if (problem) {
    return {
      refused: new SupersedesRefusedError(supersedes, problem).message,
    };
  }
  const run = runWithSupersedes(supersedes, file);
  let result: T;
  try {
    result = await run.result;
  } catch (err) {
    if (refusedRun(run.slot)) return { refused: run.slot.refused! };
    throw err;
  }
  if (refusedRun(run.slot)) return { refused: run.slot.refused! };
  return { refused: null, result, slot: run.slot };
}

/** The insert door refused a row, and no other row of the call replaced it. */
function refusedRun(slot: SupersedesSlot): boolean {
  return slot.refused !== null && slot.replacedBy === null;
}

/**
 * Said when the call did not replace the failed proposal: the agent must not
 * believe it ended. Two different facts, never one sentence:
 *  - it filed nothing for review (a write that applied at once, or a reply
 *    that filed no proposal);
 *  - it filed a proposal, but the failed one did not end. The insert door
 *    refuses a filing that could not end it and holds the failed row locked
 *    from its check to the end, so this should not happen; were it to, the
 *    agent hears it as it is, never as "filed nothing".
 */
export function leftFailedNote(slot: SupersedesSlot): string {
  return slot.filed
    ? `supersedes: this call filed proposal ${slot.filed}, but proposal ${slot.proposalId} did not end (still failed): withdraw one of the two, or tell the person.`
    : `supersedes: this call filed nothing for review, so proposal ${slot.proposalId} was left as it is (still failed).`;
}
