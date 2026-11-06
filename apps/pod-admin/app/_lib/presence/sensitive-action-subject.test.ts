/**
 * A sensitive action's proof (W3 slice 3) is bound to the exact call: the
 * challenge names `{action: {path, input}}`, and the pod digests the raw input
 * it receives minus `presence`. These pin the client half of that contract
 * against the pod's own digest (`presenceActionDigest`, the one the step-up
 * middleware runs), and that the dialog's words never reach the pod. Each
 * action's words are the shared title (`SENSITIVE_ACTION_TOKENS`), tested
 * in `@synap-core/types/presence`.
 */
import { describe, expect, it } from "vitest";
import {
  presenceActionDigest,
  presenceActionSubject,
} from "@synap-core/types/presence";
import { challengeInput } from "./presence-model";

describe("a sensitive action's challenge", () => {
  it("sends the call's own input, without the dialog's words", () => {
    const input = { agentUserId: "a1", posture: null };
    expect(
      challengeInput({
        action: { path: "agentUsers.setPosture", input },
        doing: "change whether this agent’s changes wait for you",
        label: "x",
      })
    ).toEqual({ action: { path: "agentUsers.setPosture", input } });
  });

  it("the pod's digest of the call (input + presence) equals the digest of the input the challenge named", async () => {
    const input = { keyId: "k1", grants: [{ permissions: ["a", "b"] }] };
    const proof = {
      kind: "device_key",
      challengeId: "c",
      keyId: "d",
      signature: "s",
    };
    const named = await presenceActionDigest("apiKeys.setGrants", input);
    // Key order and the proof never change it: the pod sorts keys and drops `presence`.
    const sent = await presenceActionDigest("apiKeys.setGrants", {
      presence: proof,
      grants: [{ permissions: ["a", "b"] }],
      keyId: "k1",
    });
    expect(sent).toBe(named);
    // Another call's input is another subject: a proof for key A never rotates key B.
    expect(
      presenceActionSubject(
        "apiKeys.setGrants",
        await presenceActionDigest("apiKeys.setGrants", {
          ...input,
          keyId: "k2",
        })
      )
    ).not.toBe(presenceActionSubject("apiKeys.setGrants", named));
  });
});
