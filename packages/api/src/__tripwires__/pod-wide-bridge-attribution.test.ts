import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { resolveConfinedWorkspace } from "../routers/hub-protocol/confine-workspace.js";
import { shouldRejectUnattributedWrite } from "../routers/mcp/http-handler.js";

/**
 * TRIPWIRE — pod-wide bridge model: pod-wide ≠ unattributed.
 *
 * The pod-wide bridge decision lets ONE unbound service/bot key land inbound
 * traffic across every workspace (role-routing derives placement). Two
 * orthogonal invariants MUST both hold, and they are easy to conflate:
 *
 *   1. CONFINEMENT ("which workspace") — an UNBOUND service key
 *      (`keyType==='service'`, `keyWorkspaceId==null`) is pod-wide: it never
 *      403s on a pod-wide (null) request. A BOUND service key still confines.
 *
 *   2. ATTRIBUTION ("who") — a write with no acting user (null `linkedUserId`
 *      on a bare user_pat/hub_inbound key) is STILL hard-rejected. Making the
 *      key pod-wide must NEVER weaken this: pod-wide widens the workspace lens,
 *      it does not admit an anonymous writer.
 *
 * If someone "opens up" confinement by also dropping the attribution reject,
 * this test fails. If someone re-pins a pod-wide unbound key to a workspace,
 * this test fails.
 */

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const writeToolDefs = [
  { name: "synap_capture", annotations: { readOnlyHint: false } },
] as const;
const writeCall = { method: "tools/call", params: { name: "synap_capture" } };

describe("pod-wide bridge — confinement (which workspace)", () => {
  it("UNBOUND service key is pod-wide: null request passes through, no 403", () => {
    // The bridge key with no workspace binding + a pod-wide (null) request
    // resolves to pod-wide, never throwing.
    expect(resolveConfinedWorkspace("service", null, null)).toBeNull();
    expect(
      resolveConfinedWorkspace("service", null, undefined)
    ).toBeUndefined();
  });

  it("UNBOUND service key still honours an explicit workspace request", () => {
    // Pod-wide capable, but a caller may still target one workspace.
    expect(resolveConfinedWorkspace("service", null, WS)).toBe(WS);
  });

  it("BOUND service key still confines (a different request 403s)", () => {
    expect(resolveConfinedWorkspace("service", WS, WS)).toBe(WS);
    expect(() => resolveConfinedWorkspace("service", WS, OTHER)).toThrow(
      TRPCError
    );
  });
});

describe("pod-wide bridge — attribution (who) is preserved", () => {
  it("present linkedUserId ⇒ write is ADMITTED (pod-wide, attributed)", () => {
    // The bridge key carries an acting user → the write is attributed and must
    // NOT be rejected by the attribution floor. Pod-wide + attributed = allowed.
    expect(
      shouldRejectUnattributedWrite(
        writeCall,
        writeToolDefs,
        "hub_inbound",
        "some-linked-user-id"
      )
    ).toBe(false);
  });

  it("null linkedUserId ⇒ write is REJECTED (unattributed, regardless of pod-wide)", () => {
    // Bare key, no acting user → hard-reject. Making the key pod-wide (unbound)
    // must not change this outcome.
    expect(
      shouldRejectUnattributedWrite(
        writeCall,
        writeToolDefs,
        "hub_inbound",
        null
      )
    ).toBe(true);
    expect(
      shouldRejectUnattributedWrite(writeCall, writeToolDefs, "user_pat", null)
    ).toBe(true);
  });

  it("a real agent principal (isAgent) is admitted even with null linkedUserId", () => {
    // A pod-wide agent (userType='agent', no linked human) is a legitimate
    // attributed principal — the is-agent signal admits it.
    expect(
      shouldRejectUnattributedWrite(
        writeCall,
        writeToolDefs,
        "hub_inbound",
        null,
        true
      )
    ).toBe(false);
  });
});
