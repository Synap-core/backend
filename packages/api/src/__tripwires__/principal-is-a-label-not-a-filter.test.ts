/**
 * TRIPWIRE — `ProposalPrincipal` is a LABEL and must never become a FILTER.
 *
 * `deriveProposalPrincipal` (`routers/proposals/display.ts`) answers "is a
 * human's identity actually behind this agent's act?". It is derived FROM
 * `proposals.subjectUserId` and deliberately does not CARRY it: the delegated
 * branch emits a display `name`, never the id.
 *
 * That omission is the whole defence. An id on this type would look
 * irresistibly like the right input to the owner check at
 * `routers/proposals/review-authority.ts:220-223`
 * (`isOwner = facts.agentCreatedByUserId === userId`) — and it is not one.
 * `subjectUserId` is the EFFECTIVE user of the acting principal, so on a
 * POD-WIDE agent (`apiKeys.linkedUserId === null`) it resolves to THE AGENT
 * ITSELF. Comparing it against the reviewer would let an agent's own id
 * satisfy the owner floor, re-opening the self-approval hole closed in
 * `1ce38ef0`.
 *
 * Two independent checks, because either alone is defeatable:
 *  1. BEHAVIOURAL — run the real function and prove the subject id it was
 *     given does not appear anywhere in what it returns. Survives a rename.
 *  2. STRUCTURAL — scan the declared type for an id-shaped member. Catches a
 *     field added but not yet populated, which check 1 cannot see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveProposalPrincipal } from "../routers/proposals/display.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "..", "routers", "proposals", "display.ts");

/** Every string reachable in a value, however nested. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      allStrings(v, out);
    }
  }
  return out;
}

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SUBJECT_ID = "22222222-2222-2222-2222-222222222222";

describe("tripwire: ProposalPrincipal is a label, not a filter", () => {
  it("never returns the subject user id it resolved from", () => {
    const principal = deriveProposalPrincipal({
      agentUserId: AGENT_ID,
      subjectUserId: SUBJECT_ID,
      resolveName: () => "Antoine",
    });
    expect(principal).toEqual({ kind: "delegated", name: "Antoine" });
    const strings = allStrings(principal);
    expect(strings).not.toContain(SUBJECT_ID);
    expect(strings).not.toContain(AGENT_ID);
  });

  it("never returns the subject id even when the name is unresolvable", () => {
    // The branch most likely to "helpfully" fall back to the raw id.
    const principal = deriveProposalPrincipal({
      agentUserId: AGENT_ID,
      subjectUserId: SUBJECT_ID,
      resolveName: () => undefined,
    });
    expect(principal).toEqual({ kind: "delegated" });
    expect(allStrings(principal)).not.toContain(SUBJECT_ID);
  });

  it("carries no id even on the global (agent acted as itself) reading", () => {
    const principal = deriveProposalPrincipal({
      agentUserId: AGENT_ID,
      subjectUserId: AGENT_ID,
      resolveName: () => "Antoine",
    });
    expect(principal).toEqual({ kind: "global" });
    expect(allStrings(principal)).not.toContain(AGENT_ID);
  });

  it("declares no id-shaped member on the type itself", () => {
    const src = readFileSync(SOURCE, "utf8");
    const decl = /export type ProposalPrincipal =([\s\S]*?);\n/.exec(src);
    // NON-VACUITY: a renamed or deleted type must fail loudly, not pass an
    // empty scan and certify nothing.
    expect(decl, "ProposalPrincipal declaration not found").toBeTruthy();
    const body = decl![1]!;
    expect(body).toContain("delegated");

    // Member NAMES only — the union's `kind: "unresolved" | ...` string values
    // are labels, not identifiers.
    const members = [...body.matchAll(/(\w+)\s*\??\s*:/g)].map((m) => m[1]!);
    expect(members).toContain("kind");
    const idShaped = members.filter((m) => /(^|[a-z])(id|ids|uuid)$/i.test(m));
    expect(
      idShaped,
      `ProposalPrincipal must carry no user id — found ${idShaped.join(", ")}. ` +
        "It is a LABEL; an id here becomes an owner-check input and re-opens " +
        "the pod-wide-agent self-approval hole closed in 1ce38ef0."
    ).toEqual([]);
  });
});
