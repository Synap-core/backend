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
import {
  writeChoices,
  toAccess,
  toApprovedPairs,
  type ConsentContract,
  type ConsentDraft,
  type ConsentOffer,
} from "./consent-access";

/** AppAccess v2 as `decideOAuthAuthorization` takes it (mutable lists). */
export interface AccessInput {
  version: 2;
  permissions: string[];
  read: { spaces: string[] | "all"; projects: string[] | "all" };
  write: { spaces: string[]; projects: string[] };
}

export interface AllowPayload {
  approved?: Array<{ permission: string; workspaceId: string | null }>;
  access?: AccessInput;
  askWritePlace?: { spaces: string[]; projects: string[] };
}

/** A v2 access in the decide (and `apps.updateAccess`) input's shape. */
export function accessInput(a: {
  permissions: readonly string[];
  read: {
    spaces: "all" | readonly string[];
    projects: "all" | readonly string[];
  };
  write: { spaces: readonly string[]; projects: readonly string[] };
}): AccessInput {
  return {
    version: 2,
    permissions: [...a.permissions],
    read: {
      spaces: a.read.spaces === "all" ? "all" : [...a.read.spaces],
      projects: a.read.projects === "all" ? "all" : [...a.read.projects],
    },
    write: { spaces: [...a.write.spaces], projects: [...a.write.projects] },
  };
}

export function allowPayload(input: {
  /** The consent context's `app` (null: not a pod app). */
  app: {
    ask: {
      pairs: ReadonlyArray<{ permission: string; workspaceId: string }>;
    } | null;
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
    if (!contract.ask.needsWritePlace || !askWrite) return {};
    // Only places the offer lets it change things in (never "all").
    const choices = offer ? writeChoices(offer) : null;
    const spaces = choices?.spaces.map((s) => s.workspaceId) ?? [];
    const projects = choices?.projects.map((p) => p.projectId) ?? [];
    return {
      askWritePlace: {
        spaces: askWrite.write.spaces.filter((id) => spaces.includes(id)),
        projects: askWrite.write.projects.filter((id) => projects.includes(id)),
      },
    };
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
    ...(contract ? { access: accessInput(toAccess(draft, offer)) } : {}),
  };
}

/** A failed decision is drawn on its own screen only for a client with no inline failure. */
export function showsErrorScreen(
  step: { kind: string },
  app: object | null
): boolean {
  return step.kind === "error" && !app;
}
