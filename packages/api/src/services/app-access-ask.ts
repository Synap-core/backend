/**
 * An app asks for ONE MORE thing (plan 647ebfd4 option C, founder 16 Nov
 * 2026): "Content Studio asks to read notes in Content OS". The person
 * answers in the app (the consent screen's short mode, `synap_ask`) or from a
 * card (Relay Home, the browser's needs-you), and an approval only ever ADDS:
 * the `app/connect` executor's `mode: "add"` merges the pairs into the
 * approval as it stands at approval time (`AppRepository.addApprovedRequests`).
 *
 * The rules (founder defaults, 16 Nov 2026):
 *  1. CEILING. A pod app (CIMD client) may ask only for pairs its client-id
 *     document declares, in spaces the person may give (`oauthAppOffer`):
 *     `appAskCeiling`. A permission declared pod-wide is offered only
 *     pod-wide, never per space, so it is not askable here; a review verb
 *     is never offered to an app that is not a Synap app (as on the consent
 *     screen, `appPermissions`).
 *  2. THE PERSON'S TAP IS THE AUTHORITY. The app's own token files the ask:
 *     this door, alone, does not bound the ask by what the caller holds
 *     (`assertRequestsWithinCaller`), because nothing is granted until the
 *     person approves, and the executor re-checks the ceiling and the
 *     person's reach (`assertOwnerMayGrant`) at that moment.
 *  3. NO NAGGING. One open ask per app per pair; an ask waits
 *     `APP_ACCESS_ASK_TTL_DAYS` then expires; "Not now" (a declined ask)
 *     keeps the same pair quiet for `APP_ACCESS_ASK_QUIET_DAYS`. The app
 *     reads its ask's answer (`readAppAccessAsk`) instead of asking again.
 *  4. WRITES STAY PER SPACE. Every pair names one space (decision e1b59d38).
 *
 * Only a pod app's connection (`apps.mode = "oauth"`) asks here: a registered
 * (CLI) app keeps `POST /apps/:id/connect`, whose approval replaces.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  drizzleSql,
  proposals,
  transitionProposal,
  AppRepository,
  APP_CONNECT_PROPOSAL_TYPE,
  APP_CONNECT_TARGET_TYPE,
  APP_EVENT_ACTIONS,
  readAppConnectRequests,
  ProposalStatus,
} from "@synap/database";
import type { AppApprovedRequest } from "@synap/database/schema";
import {
  APP_ACCESS_ASK_QUIET_DAYS,
  APP_ACCESS_ASK_TTL_DAYS,
  formatAppAccessAskPair,
  permissionWithin,
  withAppRequestScope,
  type AppAccessAskPair,
  type AppAccessAskStatus,
} from "@synap-core/types/grants";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import { createPendingProposal } from "../utils/permission-check.js";
import { openLink } from "../utils/deep-links.js";
import { auditLog } from "../utils/audit-log.js";
import { findClient } from "../routers/oauth/store.js";
import { isSynapApp } from "../routers/oauth/config.js";
import { grantsDecision } from "../routers/oauth/app-client.js";
import {
  assertOwnerMayGrant,
  oauthAppOffer,
  type OAuthAppOfferItem,
} from "./app-connect.js";

/** `data.mode` of an additive `app/connect`. */
export const APP_CONNECT_ADD_MODE = "add" as const;
/** `data.via` of an ask the app filed itself (this door). */
export const APP_ACCESS_ASK_VIA = "access-ask" as const;
/** `data.via` of a request filed by the consent screen (`connectOAuthApp`). */
export const APP_CONSENT_VIA = "oauth-consent" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One pair resolved to a space the person may give it in. */
export interface ResolvedAskPair {
  permission: string;
  workspaceId: string;
  workspaceName: string;
}

/** A pod app connection, as an ask needs it. */
export interface AskingApp {
  id: string;
  publicId: string;
  name: string;
  ownerUserId: string;
  oauthClientId: string | null;
}

const pairKey = (r: { permission: string; workspaceId: string | null }) =>
  `${r.permission}\u0000${r.workspaceId}`;

/** Is this `app/connect` payload an additive ask (`data.mode`)? */
export function isAddMode(data: unknown): boolean {
  const outer = (data ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  return inner.mode === APP_CONNECT_ADD_MODE;
}

/**
 * What this app may ever ask its person for: each permission its cached
 * client-id document declares per space (`requestedPermissions` minus the
 * pod-wide ones, minus the review verbs for an app that is not a Synap app),
 * with the spaces the person may give it in (`oauthAppOffer`). Read from the
 * pod's cached copy, the document the person consented to.
 */
export async function appAskCeiling(app: {
  ownerUserId: string;
  oauthClientId: string | null;
}): Promise<OAuthAppOfferItem[]> {
  if (!app.oauthClientId) return [];
  const client = await findClient(app.oauthClientId);
  if (!client || client.clientKind !== "cimd") return [];
  const podWide = new Set(client.requestedPodWide ?? []);
  const synapApp = isSynapApp(client.clientId);
  const declared = client.requestedPermissions.filter(
    (p) => !podWide.has(p) && (synapApp || !grantsDecision(p))
  );
  return oauthAppOffer(app.ownerUserId, declared);
}

/**
 * The asked pairs, each resolved within the ceiling: a space id must be on
 * offer for that permission; a template names the offered spaces made from
 * it. `undeclared`: permissions the document does not declare (exactly);
 * `notOnOffer`: pairs whose space the person cannot give it in, or no space
 * made from that template. Pure.
 */
export function resolveAskPairs(
  ceiling: readonly OAuthAppOfferItem[],
  asked: readonly AppAccessAskPair[]
): {
  pairs: ResolvedAskPair[];
  undeclared: string[];
  notOnOffer: AppAccessAskPair[];
} {
  const pairs: ResolvedAskPair[] = [];
  const undeclared: string[] = [];
  const notOnOffer: AppAccessAskPair[] = [];
  const seen = new Set<string>();
  for (const ask of asked) {
    const item = ceiling.find((o) => o.permission === ask.permission);
    if (!item) {
      if (!undeclared.includes(ask.permission)) undeclared.push(ask.permission);
      continue;
    }
    const spaces = item.workspaces.filter((w) =>
      "workspaceId" in ask
        ? w.workspaceId === ask.workspaceId
        : w.templateSlug === ask.template
    );
    if (spaces.length === 0) {
      notOnOffer.push(ask);
      continue;
    }
    for (const w of spaces) {
      const pair = {
        permission: ask.permission,
        workspaceId: w.workspaceId,
        workspaceName: w.workspaceName,
      };
      if (seen.has(pairKey(pair))) continue;
      seen.add(pairKey(pair));
      pairs.push(pair);
    }
  }
  return { pairs, undeclared, notOnOffer };
}

/**
 * Refuse, with a code the app reads, an ask that names anything beyond the
 * ceiling. Nothing is filed for a partly-askable call: the app asks again
 * for what it may ask.
 */
function assertAskWithinCeiling(
  appName: string,
  resolved: ReturnType<typeof resolveAskPairs>
): void {
  if (resolved.undeclared.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${appName} can only ask for what its description declares; it does not declare ${resolved.undeclared.join(", ")}.`,
      cause: { reasonCode: "ASK_NOT_DECLARED" },
    });
  }
  if (resolved.notOnOffer.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `The person cannot give ${appName} ${resolved.notOnOffer
        .map(formatAppAccessAskPair)
        .join(", ")}: no space of theirs it could have that in.`,
      cause: { reasonCode: "ASK_NOT_ON_OFFER" },
    });
  }
}

/**
 * The executor's re-check at approval time (rule 1): every pair an additive
 * approval adds is in the ceiling as it stands NOW (the document the pod
 * holds, the spaces the person may give).
 */
export async function assertAddWithinCeiling(
  app: AskingApp,
  requests: readonly AppApprovedRequest[]
): Promise<void> {
  const ceiling = await appAskCeiling(app);
  const beyond = requests.filter(
    (r) =>
      r.workspaceId === null ||
      !ceiling.some(
        (o) =>
          o.permission === r.permission &&
          o.workspaces.some((w) => w.workspaceId === r.workspaceId)
      )
  );
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${app.name} can no longer be given ${beyond
        .map((r) => r.permission)
        .join(
          ", "
        )} there: its description or your spaces changed since it asked.`,
      cause: { reasonCode: "ASK_NOT_ON_OFFER" },
    });
  }
}

/**
 * The pod app connection a caller's token is for: its grant names the app
 * (`clientId` = public id), the app is a live pod app connection, and the
 * caller is its person. Anything else may not ask on its behalf.
 */
async function loadAskingApp(
  publicId: string | null | undefined,
  callerUserId: string
): Promise<AskingApp & { approvedRequests: AppApprovedRequest[] }> {
  const found = publicId
    ? await new AppRepository(db).getByPublicId(publicId)
    : null;
  const app = found?.app;
  if (
    !app ||
    app.mode !== "oauth" ||
    !app.oauthClientId ||
    app.revokedAt ||
    app.ownerUserId !== callerUserId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only a pod app, signed in as its person, can ask that person for more access.",
      cause: { reasonCode: "NOT_A_POD_APP" },
    });
  }
  return {
    id: app.id,
    publicId: app.publicId,
    name: app.name,
    ownerUserId: app.ownerUserId,
    oauthClientId: app.oauthClientId,
    approvedRequests: app.approvedRequests ?? [],
  };
}

/** The additive asks of one app (or of every app), by status. */
function askRows(where: ReturnType<typeof and>) {
  return db
    .select({
      id: proposals.id,
      status: proposals.status,
      data: proposals.data,
      expiresAt: proposals.expiresAt,
      reviewedAt: proposals.reviewedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, APP_CONNECT_TARGET_TYPE),
        eq(proposals.proposalType, APP_CONNECT_PROPOSAL_TYPE),
        drizzleSql`COALESCE(${proposals.data}->'data'->>'mode', ${proposals.data}->>'mode') = ${APP_CONNECT_ADD_MODE}`,
        where
      )
    );
}

/**
 * The pending additive asks whose own `expiresAt` passed (`appId` = one app;
 * omitted = every app, the 6-hourly backstop in `expireLapsedProposals`).
 */
export async function lapsedAppAskIds(
  now: Date,
  appId?: string
): Promise<string[]> {
  const rows = await askRows(
    and(
      eq(proposals.status, ProposalStatus.PENDING),
      isNotNull(proposals.expiresAt),
      lt(proposals.expiresAt, now),
      ...(appId ? [eq(proposals.targetId, appId)] : [])
    )
  );
  return rows.map((r) => r.id);
}

/** Expire one app's lapsed asks now, re-asserting PENDING (never over a decision). */
async function expireLapsedAsks(appId: string, now: Date): Promise<void> {
  const ids = await lapsedAppAskIds(now, appId);
  if (ids.length === 0) return;
  await transitionProposal(db, {
    to: ProposalStatus.EXPIRED,
    set: { updatedAt: now },
    where: and(
      inArray(proposals.id, ids),
      eq(proposals.status, ProposalStatus.PENDING)
    ),
  });
}

/** What happened to each pair the app named. */
export type AskPairState = "asked" | "given" | "open" | "quiet";

export interface AppAccessAskReceipt {
  /** The ask filed now, or null when every pair was given, open or quiet. */
  id: string | null;
  status: AppAccessAskStatus | null;
  reviewUrl: string | null;
  expiresAt: string | null;
  pairs: Array<
    ResolvedAskPair & {
      state: AskPairState;
      /** The ask that already holds it (`open`) or declined it (`quiet`). */
      askId?: string;
    }
  >;
}

/**
 * File an app's ask (rules 1–4): resolve the pairs within the ceiling, drop
 * what it already holds, what an open ask already holds and what the person
 * declined less than `APP_ACCESS_ASK_QUIET_DAYS` ago, and file ONE pending
 * `app/connect` of mode "add" for the rest, waiting `APP_ACCESS_ASK_TTL_DAYS`.
 */
export async function fileAppAccessAsk(args: {
  /** The app the caller's grant names (`KeyGrant.clientId`). */
  publicId: string | null | undefined;
  callerUserId: string;
  /** The app's own agent, when its agent key asks (shown as who asks). */
  agentUserId?: string | null;
  pairs: readonly AppAccessAskPair[];
  /** The app's reason, display text. */
  reason?: string | null;
  now?: Date;
}): Promise<AppAccessAskReceipt> {
  const now = args.now ?? new Date();
  const app = await loadAskingApp(args.publicId, args.callerUserId);
  const resolved = resolveAskPairs(await appAskCeiling(app), args.pairs);
  assertAskWithinCeiling(app.name, resolved);
  await assertOwnerMayGrant(app.ownerUserId, resolved.pairs);

  await expireLapsedAsks(app.id, now);
  const given = new Set(app.approvedRequests.map(pairKey));
  const open = new Map<string, string>();
  const quiet = new Map<string, string>();
  const rows = await askRows(
    and(
      eq(proposals.targetId, app.id),
      inArray(proposals.status, [
        ProposalStatus.PENDING,
        ProposalStatus.REJECTED,
      ])
    )
  );
  const quietSince = new Date(
    now.getTime() - APP_ACCESS_ASK_QUIET_DAYS * DAY_MS
  );
  for (const row of rows) {
    const into =
      row.status === ProposalStatus.PENDING
        ? open
        : row.reviewedAt && row.reviewedAt > quietSince
          ? quiet
          : null;
    if (!into) continue;
    for (const r of readAppConnectRequests(row.data))
      if (!into.has(pairKey(r))) into.set(pairKey(r), row.id);
  }

  const pairs: AppAccessAskReceipt["pairs"] = resolved.pairs.map((p) => {
    const key = pairKey(p);
    if (given.has(key)) return { ...p, state: "given" };
    if (open.has(key)) return { ...p, state: "open", askId: open.get(key)! };
    if (quiet.has(key)) return { ...p, state: "quiet", askId: quiet.get(key)! };
    return { ...p, state: "asked" };
  });
  const fresh = pairs.filter((p) => p.state === "asked");
  if (fresh.length === 0) {
    return { id: null, status: null, reviewUrl: null, expiresAt: null, pairs };
  }

  const requests = fresh.map((p) => ({
    ...withAppRequestScope({
      permission: p.permission,
      workspaceId: p.workspaceId,
    }),
    workspaceName: p.workspaceName,
  }));
  const title = summarizeAppConnectRequest({
    appName: app.name,
    requests,
    mode: APP_CONNECT_ADD_MODE,
  }).title;
  const expiresAt = new Date(now.getTime() + APP_ACCESS_ASK_TTL_DAYS * DAY_MS);
  const agentUserId = args.agentUserId ?? null;
  const proposal = await createPendingProposal({
    userId: app.ownerUserId,
    workspaceId: null,
    targetType: APP_CONNECT_TARGET_TYPE,
    targetId: app.id,
    proposalType: APP_CONNECT_PROPOSAL_TYPE,
    data: {
      appId: app.id,
      publicId: app.publicId,
      name: app.name,
      oauthClientId: app.oauthClientId,
      mode: APP_CONNECT_ADD_MODE,
      via: APP_ACCESS_ASK_VIA,
      ...(args.reason ? { reason: args.reason } : {}),
      requests,
      // Frozen at filing: what an approval may narrow, never widen.
      asked: fresh.map(({ permission, workspaceId }) => ({
        permission,
        workspaceId,
      })),
    },
    agentUserId,
    createdBy: agentUserId ?? app.ownerUserId,
    proposedByUserId: agentUserId ? null : app.ownerUserId,
    expiresAt,
    notificationDescription: title,
  });
  await auditLog({
    subjectType: "app",
    action: APP_EVENT_ACTIONS.requested,
    phase: "completed",
    subjectId: app.id,
    userId: app.ownerUserId,
    workspaceId: null,
    appId: app.publicId,
    data: {
      name: app.name,
      publicId: app.publicId,
      proposalId: proposal.id,
      requests,
      mode: APP_CONNECT_ADD_MODE,
      via: APP_ACCESS_ASK_VIA,
    },
  });
  return {
    id: proposal.id,
    status: "pending",
    reviewUrl: openLink(proposal.id),
    expiresAt: expiresAt.toISOString(),
    pairs: pairs.map((p) =>
      p.state === "asked" ? { ...p, askId: proposal.id } : p
    ),
  };
}

/** A proposal status as the app reads its ask. */
export function askStatusOf(
  status: string,
  expiresAt: Date | null,
  now: Date
): AppAccessAskStatus {
  if (status === ProposalStatus.APPROVED) return "allowed";
  if (status === ProposalStatus.REJECTED) return "declined";
  if (
    status === ProposalStatus.PENDING &&
    !(expiresAt && expiresAt.getTime() < now.getTime())
  )
    return "pending";
  // Expired, withdrawn (a revoke, a full re-consent) or failed: nobody
  // allowed it, and nothing waits any more.
  return "expired";
}

export interface AppAccessAskView {
  id: string;
  status: AppAccessAskStatus;
  pairs: ResolvedAskPair[];
  expiresAt: string | null;
  decidedAt: string | null;
}

/** An app reads its OWN ask's answer; another app's, or no ask, is NOT_FOUND. */
export async function readAppAccessAsk(args: {
  publicId: string | null | undefined;
  callerUserId: string;
  askId: string;
  now?: Date;
}): Promise<AppAccessAskView> {
  const now = args.now ?? new Date();
  const app = await loadAskingApp(args.publicId, args.callerUserId);
  const [row] = await askRows(
    and(eq(proposals.id, args.askId), eq(proposals.targetId, app.id))
  );
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such ask." });
  }
  const outer = (row.data ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  const names = new Map<string, string>();
  for (const r of Array.isArray(inner.requests) ? inner.requests : []) {
    const rec = r as Record<string, unknown>;
    if (
      typeof rec.workspaceId === "string" &&
      typeof rec.workspaceName === "string"
    )
      names.set(rec.workspaceId, rec.workspaceName);
  }
  const status = askStatusOf(row.status, row.expiresAt, now);
  return {
    id: row.id,
    status,
    pairs: readAppConnectRequests(row.data).flatMap((r) =>
      r.workspaceId
        ? [
            {
              permission: r.permission,
              workspaceId: r.workspaceId,
              workspaceName: names.get(r.workspaceId) ?? "",
            },
          ]
        : []
    ),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    decidedAt:
      status === "allowed" || status === "declined"
        ? (row.reviewedAt?.toISOString() ?? null)
        : null,
  };
}

/**
 * Is this refused write one the app could ASK for (rule 6 of the plan)? The
 * denied request key is covered by a permission the app's document declares
 * per space, and the refusal names the space. Returns the pair to ask for
 * (the declared permission, the space), or null. A denial with no space, or
 * a key that is not an app's, is never askable.
 */
export async function askableDenial(denial: {
  action?: string;
  workspaceId?: string | null;
  clientId?: string | null;
}): Promise<{ permission: string; workspaceId: string } | null> {
  if (!denial.action || !denial.workspaceId || !denial.clientId) return null;
  const found = await new AppRepository(db).getByPublicId(denial.clientId);
  const app = found?.app;
  if (!app || app.mode !== "oauth" || app.revokedAt || !app.oauthClientId)
    return null;
  const client = await findClient(app.oauthClientId);
  if (!client || client.clientKind !== "cimd") return null;
  const podWide = new Set(client.requestedPodWide ?? []);
  const synapApp = isSynapApp(client.clientId);
  const permission = client.requestedPermissions.find(
    (p) =>
      !podWide.has(p) &&
      (synapApp || !grantsDecision(p)) &&
      permissionWithin(denial.action!, [p])
  );
  return permission ? { permission, workspaceId: denial.workspaceId } : null;
}
