/**
 * What Allow SENDS, decided in one pure place so it is tested without a
 * browser (pod-admin's vitest runs in node). Three shapes:
 *
 *  - the full consent: today's `approved` pairs (`toApprovedPairs`), plus the
 *    AppAccess v2 itself (`access`) when the pod speaks the W3d contract;
 *  - today's short ask (`app.ask`, pairs): exactly the asked pairs, never a
 *    full `access` (it would replace everything the app holds);
 *  - the contract's short ask (`app.access.ask`, v1.1: only when the
 *    connection names a project): neither pairs nor access; Allow ADDS
 *    `ask.adds` where it already works, plus `askWritePlace` only when the
 *    server says it needs one (Q4).
 */
import type { AppAccess } from "@synap-core/types/grants";
import {
  toAccess,
  toApprovedPairs,
  type ConsentContract,
  type ConsentDraft,
  type ConsentOffer,
} from "./consent-access";

export interface AllowPayload {
  approved?: Array<{ permission: string; workspaceId: string | null }>;
  access?: AppAccess;
  askWritePlace?: AppAccess["write"];
}

export function allowPayload(input: {
  /** The consent context's `app` (null: not a pod app). */
  app: {
    ask: { pairs: ReadonlyArray<{ permission: string; workspaceId: string }> } | null;
  } | null;
  contract: ConsentContract | null;
  offer: ConsentOffer | null;
  draft: ConsentDraft | null;
  /** The short ask's first write place (Q4), when it needs one. */
  askWrite: ConsentDraft | null;
}): AllowPayload {
  const { app, contract, offer, draft, askWrite } = input;
  if (!app) return {};
  if (contract?.ask) {
    return contract.ask.needsWritePlace && askWrite
      ? { askWritePlace: { ...askWrite.write } }
      : {};
  }
  if (app.ask) {
    return {
      approved: app.ask.pairs.map(({ permission, workspaceId }) => ({
        permission,
        workspaceId,
      })),
    };
  }
  if (!offer || !draft) return { approved: [] };
  return {
    approved: toApprovedPairs(draft, offer),
    ...(contract ? { access: toAccess(draft, offer) } : {}),
  };
}

/** A failed decision is drawn on its own screen only for a client with no inline failure. */
export function showsErrorScreen(
  step: { kind: string },
  app: object | null
): boolean {
  return step.kind === "error" && !app;
}
