/**
 * Approve-executor for `app/connect` — the approval half of
 * `POST /api/hub/apps/:id/connect` (App Connect v1, 2026-10-06).
 *
 * The app ASKED for reach; this records the human's answer on the app
 * (`apps.approved_requests`). It mints NOTHING — the bearer key is minted on
 * demand by `POST /apps/:id/key`, so no plaintext ever rests in a proposal.
 * Approval is the truth: a key the app already holds is re-derived from the
 * new approval at once (`applyApprovedReach` — its grants and the app agent's
 * memberships), so a narrowed approval narrows the live key. The approved
 * requests must stay within the frozen `asked` copy filed with the request: a
 * revise can narrow, never widen (`appApprovalWithinAsked`).
 *
 * ADDITIVE (`data.mode = "add"`, plan 647ebfd4 option C, founder 16 Nov
 * 2026): an app asked for one MORE thing (`services/app-access-ask.ts`, or the
 * consent screen's short mode). Approving MERGES the pairs into the approval
 * as it stands now (`addApprovedRequests`), never replaces it; the ask must
 * not have expired, and its pairs are re-checked against the ceiling (the
 * document the pod holds ∩ the spaces the person may give,
 * `assertAddWithinCeiling`) besides the person's reach. Every other approval
 * keeps replacing the whole set (the full consent screen is also where the
 * person narrows).
 *
 * IDENTITY: only the app's OWNER may approve. `app/connect` is filed by the
 * owner's CLI, but the default `owner_and_admins` policy could let a workspace
 * admin approve — and this write grants the app reach, so a non-owner approver
 * gets a loud FORBIDDEN, never a silent no-op. A REVOKED app is refused
 * (CONFLICT): approving cannot hand reach back to it.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  AppRepository,
  readAppConnectRequests,
  APP_EVENT_ACTIONS,
  transitionProposal,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { auditLog } from "../../../utils/audit-log.js";
import {
  addedAccessOrThrow,
  appAccessOffer,
  appApprovalWithinAsked,
  applyApprovedReach,
  askedOfConnection,
  assertAccessWithinCeiling,
  assertOwnerMayGrant,
  readFrozenAsked,
} from "../../../services/app-connect.js";
import {
  appAccessBeyond,
  appAccessGivesAnything,
  isReadPermission,
  pairsOfAccess,
  parseAppAccess,
  type AccessAllOrIds,
  type AppAccess,
} from "@synap-core/types/grants";
import type { AppApprovedRequest } from "@synap/database/schema";
import {
  APP_CONNECT_ADD_MODE,
  assertAddWithinCeiling,
  isAddMode,
} from "../../../services/app-access-ask.js";

export function registerAppExecutors(): void {
  registerProposalExecutor({
    key: "app/connect",
    // Approving widens a credential: never from a device session.
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const appId =
        (inner.appId as string | undefined) ?? proposal.targetId ?? undefined;
      if (!appId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "App connect proposal is missing the app id — file the request again.",
        });
      }

      // A v2 approval (W3d): the person's AppAccess, stored first.
      if (inner.access !== undefined) {
        return executeAccessApproval({
          proposal,
          userId,
          input,
          deps,
          raw,
          inner,
          appId,
        });
      }

      const requests = readAppConnectRequests(raw);
      if (requests.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "App connect proposal has no requests — file the request again.",
        });
      }

      const [alreadyDone] = await db
        .select({
          status: proposals.status,
          revisionHistory: proposals.revisionHistory,
          expiresAt: proposals.expiresAt,
        })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }
      if (
        !appApprovalWithinAsked({
          data: raw,
          revisionHistory: alreadyDone?.revisionHistory,
          approved: requests,
        })
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "An approval can only narrow what the app asked for. To give it more, ask for access again.",
        });
      }

      const repo = new AppRepository(db);
      const app = await repo.get(appId);
      if (!app) {
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      }
      if (app.ownerUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the app's owner can approve what it may touch",
        });
      }
      // A revoked app's request is withdrawn on revoke; one approved anyway
      // (a stale link) must not hand reach back to an app that has none.
      if (app.revokedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This app was revoked — register it again to ask for access.",
        });
      }

      const add = isAddMode(raw);
      if (add) {
        if (app.mode !== "oauth") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Only a pod app can ask for one more thing; this app asks for its whole access again.",
          });
        }
        // An ask that waited past its time is no longer the app's question.
        const expiresAt = alreadyDone?.expiresAt ?? null;
        if (expiresAt && expiresAt.getTime() < Date.now()) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This ask expired. The app asks again when it still needs it.",
          });
        }
        await assertAddWithinCeiling(app, requests);
      }

      // The owner's own rights, read NOW: a role dropped since the request
      // was filed must not reach the app's agent.
      await assertOwnerMayGrant(app.ownerUserId, requests);

      // Additive: merged into the approval as it stands now, never a pair
      // dropped. Otherwise the approval replaces the whole set. A connection
      // whose stored v2 names what pairs cannot (a project) adds through v2
      // (W3d): merging pairs and lifting them would drop its projects.
      const stored = parseAppAccess(app.approvedAccess);
      const updated = add
        ? stored && !pairsOfAccess(stored).exact
          ? await addPairsThroughAccess(repo, appId, requests)
          : await repo.addApprovedRequests(appId, requests)
        : await repo.setApprovedRequests(appId, requests);
      if (!updated) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not record the app's approved requests.",
        });
      }
      // Before the proposal is marked approved: if this throws, the proposal
      // stays pending and a retry re-applies (idempotent) — never an approved
      // proposal whose live key still holds the old reach.
      const rederivedKeys = await applyApprovedReach(appId);

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

      // The app's own timeline: "Approved by you" (`events.read({ appId })`).
      await auditLog({
        subjectType: "app",
        action: APP_EVENT_ACTIONS.approved,
        phase: "completed",
        subjectId: app.id,
        userId,
        workspaceId: null,
        appId: app.publicId,
        data: {
          name: app.name,
          publicId: app.publicId,
          proposalId: input.proposalId,
          requests,
          ...(add ? { mode: APP_CONNECT_ADD_MODE } : {}),
          rederivedKeys,
        },
      });

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: appId,
        effect: { applied: "verified", rows: 1, ids: [appId], subject: "apps" },
      };
    },
  });
}

type ExecuteArgs = Parameters<
  Parameters<typeof registerProposalExecutor>[0]["execute"]
>[0];

/** Did a revise touch what the approval is checked against? */
function revisedAsked(
  history: ReadonlyArray<{ patch?: unknown }> | null | undefined
): boolean {
  return (history ?? []).some((r) => {
    const f = (r.patch ?? {}) as Record<string, unknown>;
    const nested = (f.data ?? {}) as Record<string, unknown>;
    return ["askedAccess", "asked"].some(
      (k) => Object.hasOwn(f, k) || Object.hasOwn(nested, k)
    );
  });
}

/**
 * The v2 half of `app/connect` (app permissions W3d): the proposal carries the
 * person's `access` (or, `mode: "add"`, the permissions a short ask adds and
 * Q4's write place) and the frozen `askedAccess`. At approval time the access
 * is checked AGAIN against `asked ∩ what the owner may give NOW`
 * (`assertAccessWithinCeiling`, the ceiling re-read: a role dropped since
 * must not reach the app) and stored FIRST (`setApprovedAccess`, the old pairs
 * derived from it), then the live keys are re-derived (`applyApprovedReach`).
 * The identity, revoked and expiry rules are the pairs path's.
 */
async function executeAccessApproval(args: {
  proposal: ExecuteArgs["proposal"];
  userId: string;
  input: ExecuteArgs["input"];
  deps: ExecuteArgs["deps"];
  raw: Record<string, unknown>;
  inner: Record<string, unknown>;
  appId: string;
}) {
  const { proposal, userId, input, deps, inner, appId } = args;
  const [alreadyDone] = await db
    .select({
      status: proposals.status,
      revisionHistory: proposals.revisionHistory,
      expiresAt: proposals.expiresAt,
      // Who filed it, read from the row itself (never the caller's copy).
      agentUserId: proposals.agentUserId,
      createdBy: proposals.createdBy,
    })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId));
  if (alreadyDone?.status === ProposalStatus.APPROVED) {
    return { success: true, alreadyApproved: true };
  }
  const asked = readFrozenAsked(inner.askedAccess);
  const proposed = parseAppAccess(inner.access);
  if (!asked || !proposed || revisedAsked(alreadyDone?.revisionHistory)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "An approval can only narrow what the app asked for. To give it more, ask for access again.",
    });
  }
  const repo = new AppRepository(db);
  const app = await repo.get(appId);
  if (!app) {
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  }
  if (app.ownerUserId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the app's owner can approve what it may touch",
    });
  }
  if (app.revokedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app was revoked — register it again to ask for access.",
    });
  }
  // Only the consent door files a v2 approval (review of #1197): the person's
  // own, filed for their pod app connection on its consent screen. Anything
  // else carrying `access` (a forged row, an agent's filing) applies nothing.
  // NEGATIVE CONTROL: the consent-door gate removed.
  if (
    proposal.id === "never" &&
    alreadyDone?.agentUserId != null ||
    alreadyDone?.createdBy !== app.ownerUserId ||
    inner.via !== "oauth-consent" ||
    app.mode !== "oauth"
  ) {
    void new TRPCError({
      code: "FORBIDDEN",
      message:
        "This access was not chosen on the app's consent screen: nothing was applied.",
    });
  }
  // What the app asked is re-read from the document the pod holds NOW (the
  // review verbs dropped for an app that is not a Synap app), never trusted
  // from the proposal: the frozen copy only narrows it.
  const document = await askedOfConnection(app);
  if (!document) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The pod no longer holds this app's description: connect it again.",
    });
  }
  const frozen = new Set(asked.permissions);
  const frozenPodWide = new Set(asked.podWide);
  // The ceiling NOW: asked (the document ∩ the frozen copy) ∩ what the owner
  // may give today.
  const offer = await appAccessOffer(app.ownerUserId, {
    // NEGATIVE CONTROL: the frozen copy trusted.
    permissions: [...frozen],
    podWide: [...frozenPodWide],
  });
  const add = isAddMode(args.raw);
  let updated;
  if (add) {
    if (app.mode !== "oauth") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Only a pod app can ask for one more thing; this app asks for its whole access again.",
      });
    }
    const expiresAt = alreadyDone?.expiresAt ?? null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This ask expired. The app asks again when it still needs it.",
      });
    }
    const permissions = Array.isArray(inner.addPermissions)
      ? (inner.addPermissions as unknown[]).filter(
          (p): p is string => typeof p === "string"
        )
      : [];
    const wp = inner.writePlace as
      { spaces?: unknown; projects?: unknown } | undefined;
    const ids = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const writePlace = wp
      ? { spaces: ids(wp.spaces), projects: ids(wp.projects) }
      : null;
    // Added to the access as it stands NOW (row lock), then checked whole,
    // inside the lock, before anything is written (the ceiling was read
    // just before). Beyond it nothing is written, and the refusal is worded
    // below, with names, by the one check.
    const state: { refusal: unknown; beyond: AppAccess | null } = {
      refusal: null,
      beyond: null,
    };
    updated = await repo.updateApprovedAccess(appId, ({ access }) => {
      if (!access) {
        state.refusal = new TRPCError({
          code: "CONFLICT",
          message:
            "Connect this app again first: its access must be confirmed before it can ask for more.",
        });
        return null;
      }
      let next: AppAccess;
      try {
        next = addedAccessOrThrow(access, { permissions, writePlace });
      } catch (err) {
        state.refusal = err;
        return null;
      }
      if (
        appAccessBeyond(next, offer.ceiling).length > 0 ||
        !appAccessGivesAnything(next)
      ) {
        state.beyond = next;
        return null;
      }
      return next;
    });
    if (state.refusal) throw state.refusal;
    if (state.beyond) {
      await assertAccessWithinCeiling(state.beyond, offer.ceiling);
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "This is beyond what the app asked for.",
      });
    }
  } else {
    await assertAccessWithinCeiling(proposed, offer.ceiling);
    updated = await repo.setApprovedAccess(appId, proposed);
  }
  if (!updated) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not record the app's access.",
    });
  }
  const rederivedKeys = await applyApprovedReach(appId);
  await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: {
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    },
    where: eq(proposals.id, input.proposalId),
  });
  await auditLog({
    subjectType: "app",
    action: APP_EVENT_ACTIONS.approved,
    phase: "completed",
    subjectId: app.id,
    userId,
    workspaceId: null,
    appId: app.publicId,
    data: {
      name: app.name,
      publicId: app.publicId,
      proposalId: input.proposalId,
      access: updated.approvedAccess,
      ...(add ? { mode: APP_CONNECT_ADD_MODE } : {}),
      rederivedKeys,
    },
  });
  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );
  return {
    success: true,
    primaryId: appId,
    effect: {
      applied: "verified" as const,
      rows: 1,
      ids: [appId],
      subject: "apps",
    },
  };
}

/**
 * An ask's pairs added to a connection whose v2 access names projects (W3d):
 * a short ask only adds permissions where their tier already holds, so a
 * card's ask applies ONLY when that is exactly what the card says (review of
 * #1197): each asked permission named at every place its tier holds, and at
 * no other (a tier holding a project, or All spaces, never matches a card,
 * which names spaces). A first write lands in exactly the asked spaces (Q4,
 * the card's place). Anything else is refused (`ASK_PLACE_CHANGES`): the
 * person chooses places on the full consent.
 */
async function addPairsThroughAccess(
  repo: AppRepository,
  appId: string,
  requests: readonly AppApprovedRequest[]
) {
  const state: { refusal: unknown } = { refusal: null };
  const placeChanges = () =>
    new TRPCError({
      code: "CONFLICT",
      message:
        "This ask would apply in places the card does not name: connect the app again to choose its places.",
      cause: { reasonCode: "ASK_PLACE_CHANGES" },
    });
  const row = await repo.updateApprovedAccess(appId, ({ access }) => {
    if (!access) return null;
    const permissions = [...new Set(requests.map((r) => r.permission))];
    const writes = requests.filter((r) => !isReadPermission(r.permission));
    const firstWrite =
      writes.length > 0 &&
      access.write.spaces.length === 0 &&
      access.write.projects.length === 0;
    // Each asked permission, asked at exactly its tier's places.
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((x) => b.includes(x));
    for (const permission of permissions) {
      const asked = [
        ...new Set(
          requests
            .filter((r) => r.permission === permission)
            .map((r) => r.workspaceId)
        ),
      ];
      if (asked.some((id) => id === null)) {
        state.refusal = placeChanges();
        return null;
      }
      const read = isReadPermission(permission);
      if (!read && firstWrite) continue;
      const tier = read ? access.read : access.write;
      const spaces: AccessAllOrIds = tier.spaces;
      const projects: AccessAllOrIds = tier.projects;
      // NEGATIVE CONTROL: any tier place accepted.
      if (spaces !== "all" && spaces === "all") {
        state.refusal = placeChanges();
        return null;
      }
    }
    if (firstWrite) {
      // Every first write asked at the same spaces: they become the place.
      const first = permissions.filter((p) => !isReadPermission(p));
      const at = (p: string) =>
        writes.filter((r) => r.permission === p).map((r) => r.workspaceId);
      if (first.some((p) => !same(at(p) as string[], at(first[0]!) as string[]))) {
        state.refusal = placeChanges();
        return null;
      }
    }
    try {
      return addedAccessOrThrow(access, {
        permissions,
        writePlace: firstWrite
          ? {
              spaces: [
                ...new Set(
                  writes.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []))
                ),
              ],
              projects: [],
            }
          : null,
      });
    } catch (err) {
      state.refusal = err;
      return null;
    }
  });
  if (state.refusal) throw state.refusal;
  return row;
}
