/**
 * Backend → IS playbook choice (`POST /api/playbook-choice`,
 * synap-intelligence-service routes/session-intelligence/playbook-choice.ts).
 *
 * Asked only when the lexical ranker leaves ≥2 playbooks that could shape a
 * session being started. The IS picks one of the candidates or abstains; the
 * CALLER applies its own confidence threshold. Throws on failure (shared
 * transport) — an IS that could not answer is not an abstain.
 */

import { postSessionIntelligence } from "./session-intelligence-client.js";

export interface PlaybookChoiceRequest {
  /** What the session is for — its title and goal. */
  content: string;
  candidates: Array<{ id: string; name: string; description?: string }>;
  /** Only true when the pod consented to the third-party decision model. */
  allowDecisionModel?: boolean;
}

/** Mirror of the IS `PlaybookChoiceResult`. */
export interface PlaybookChoiceResult {
  /** A candidate id, or null = none fits (abstain). */
  playbookId: string | null;
  /** Probability of the pick ∈ [0,1]; 0 on abstain. */
  confidence: number;
  reason: string;
  decider: "jev" | "llm";
  model?: string;
  /** Per candidate id plus `none` (JEV only). */
  probabilities?: Record<string, number>;
}

export function requestPlaybookChoice(
  serviceUrl: string,
  serviceApiKey: string,
  payload: PlaybookChoiceRequest
): Promise<PlaybookChoiceResult> {
  return postSessionIntelligence<PlaybookChoiceResult>(
    serviceUrl,
    serviceApiKey,
    "/api/playbook-choice",
    payload
  );
}
