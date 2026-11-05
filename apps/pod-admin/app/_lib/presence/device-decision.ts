/**
 * The device door (`/device`: a computer asking to connect, its agents), with
 * the proof of presence (W3 slice 2): the page posts its decision to its own
 * route (`app/api/device/route.ts`), which forwards it, `presence` included,
 * to `apiKeys.decideDeviceRequest`. Connecting a computer is setup, so an
 * approval is proved UP FRONT, its challenge naming this request
 * (`device_request:<requestId>`); a denial needs none. The page calls this,
 * never the route itself (tripwire `presence-approve-doors`).
 */

import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import {
  PresenceRefusedError,
  approveWithPresence,
  asPresenceCode,
  type ProvePresence,
} from "./presence-model";

/** What the page decided, as the route reads it. */
export interface DeviceDecisionBody {
  decision: "approve" | "deny";
  requestId: string;
  userCode: string;
  computerName?: string;
  [field: string]: unknown;
}

/**
 * Send the decision. Returns the pod's refusal in words, or null when it
 * landed. Not confirming the passkey is a refusal too ("Not approved: …").
 */
export async function sendDeviceDecision(args: {
  decision: DeviceDecisionBody;
  prove: ProvePresence;
  post?: typeof fetch;
}): Promise<string | null> {
  const post = args.post ?? fetch;
  const attempt = async (presence?: unknown): Promise<null> => {
    let res: Response;
    try {
      res = await post("/api/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          presence ? { ...args.decision, presence } : args.decision
        ),
      });
    } catch {
      throw new Error("Could not reach this pod.");
    }
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      reasonCode?: unknown;
    };
    const message = body.error ?? `Error (${res.status})`;
    const code = asPresenceCode(body.reasonCode);
    throw code ? new PresenceRefusedError(code, message) : new Error(message);
  };
  try {
    if (args.decision.decision !== "approve") return await attempt();
    const name = args.decision.computerName?.trim();
    return await approveWithPresence({
      subject: {
        request: { kind: "device_request", id: args.decision.requestId },
        label: buildObjectActionTitle({
          action: "connect",
          objectKind: "computer",
          objectName: name || null,
        }),
      },
      prove: args.prove,
      upFront: true,
      attempt,
    });
  } catch (err) {
    return err instanceof Error ? err.message : "Could not reach this pod.";
  }
}
