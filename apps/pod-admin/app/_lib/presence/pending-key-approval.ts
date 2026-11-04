/**
 * The pending agent-key approve doors (`/setup/agent/pending/:keyId/approve`
 * and `/approve-batch`, pod REST), with the proof of presence (W3): the
 * `/approve-agent` and `/approve-agents` pages and the Review drawer approve
 * a key through these, never by a raw POST (tripwire
 * `__tripwires__/presence-approve-doors.test.ts`).
 *
 * Connecting an AI is a sensitive approval (`agent/connect`), and a request
 * the CLI filed AS the person always needs the proof. The challenge names
 * the key (`{pendingKeyId}`); the pod binds it to the key's `agent/connect`.
 */

import {
  PresenceRefusedError,
  approveEachWithPresence,
  approveWithPresence,
  asPresenceCode,
  type ProvePresence,
} from "./presence-model";

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cross-subdomain (pod-admin.<root> → pod.<root>): send the Kratos cookie.
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: unknown;
  };
  if (!res.ok) {
    const message = data.error || `Error (${res.status})`;
    const code = asPresenceCode(data.code);
    throw code ? new PresenceRefusedError(code, message) : new Error(message);
  }
  return data;
}

/**
 * Approve ONE pending key. `body` is what the page decided (also disconnect,
 * the write mode); undefined sends none, as before.
 */
export function approvePendingKey(args: {
  podUrl: string;
  keyId: string;
  body?: Record<string, unknown>;
  prove: ProvePresence;
}): Promise<unknown> {
  const url = `${args.podUrl}/api/hub/setup/agent/pending/${encodeURIComponent(args.keyId)}/approve`;
  return approveWithPresence({
    subject: { pendingKeyId: args.keyId },
    prove: args.prove,
    attempt: (presence) =>
      post(url, presence ? { ...(args.body ?? {}), presence } : args.body),
  });
}

/** One key's outcome of `/approve-batch` (setup.ts). */
export interface PendingKeyResult {
  keyId: string;
  outcome: string;
  /** Why a key was refused (`PRESENCE_*`: it needs its proof). */
  code?: string;
}

/**
 * Approve several pending keys in one step, then each key the pod refused
 * for its proof, proved and sent again alone. `approved` is recounted from
 * the final results.
 */
export async function approvePendingKeys(args: {
  podUrl: string;
  keyIds: string[];
  prove: ProvePresence;
}): Promise<{ approved: number; results: PendingKeyResult[] }> {
  const url = `${args.podUrl}/api/hub/setup/agent/pending/approve-batch`;
  const first = (await post(url, { keyIds: args.keyIds })) as {
    results: PendingKeyResult[];
  };
  const results = await approveEachWithPresence<PendingKeyResult>({
    results: first.results,
    refusalOf: (r) => {
      const code = r.outcome === "refused" ? asPresenceCode(r.code) : null;
      return code ? { id: r.keyId, code } : null;
    },
    subjectOf: (keyId) => ({ pendingKeyId: keyId }),
    prove: args.prove,
    retryOne: async (keyId, presence) => {
      try {
        const again = (await post(url, {
          keyIds: [keyId],
          presenceByKey: { [keyId]: presence },
        })) as { results: PendingKeyResult[] };
        return (
          again.results.find((r) => r.keyId === keyId) ?? {
            keyId,
            outcome: "failed",
          }
        );
      } catch {
        return { keyId, outcome: "failed" };
      }
    },
  });
  return {
    approved: results.filter((r) => r.outcome === "approved").length,
    results,
  };
}
