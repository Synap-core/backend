/**
 * WHAT THIS PERSON CAN HAND OVER for one `provide` ask — the read every
 * surface draws its provide sheet from (`focusSessions.provideOptions`), so no
 * client works out on its own which secrets, connections or spaces apply.
 *
 * Owner-floored like the answer door (`answerSessionSlot`): only the session's
 * owner reads it, on a slot the answer door would still take. A pure
 * projection of existing reads; it writes nothing.
 *
 *   - secret     → the person's OWN readable vault entries, by name (never a
 *                  value, never someone else's or a pod-wide key — the floor
 *                  `checkProvideRef` applies), plus what handing one over
 *                  lets the asking agent do (`provide-secret-grant.ts`).
 *   - connection → the connections the person can use for THIS service (their
 *                  own, or pod-wide), each with its account hint, whether a new
 *                  one can be started here (`provide-connect.ts`), and whether
 *                  reusing one must confirm the account (several accounts).
 *   - file       → where an upload lands (`resolveProvideFileLanding`).
 */

import {
  db,
  and,
  eq,
  or,
  isNull,
  isNotNull,
  inArray,
  asc,
} from "@synap/database";
import {
  capabilities,
  focusSessions,
  links,
  projects,
  secrets,
  tools,
  workspaces,
} from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  askFingerprint,
  effectiveSlotAsk,
  PROVIDE_SECRET_GRANT_MINUTES,
  type AskProvide,
  type ProvideConnectUnavailableReason,
  type ProvideSecretGrantOffer,
} from "@synap-core/types/ask";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { canWriteWorkspace } from "../../routers/file-upload.js";
import { providerConfigKeyOf } from "../capabilities/capability-provider-resolution.js";
import { selectSlotToAnswer } from "./answer-slot.js";
import { describeAnswerRefusal } from "./session-answer.js";
import { resolveAskingAgent } from "./provide-secret-grant.js";
import { resolveProvideProvider, sameService } from "./provide-connect.js";

// ── The owed provide ask ────────────────────────────────────────────────────

export interface OwedProvideAsk {
  session: {
    id: string;
    workspaceId: string | null;
    projectId: string | null;
  };
  /** The slot's own label (what the answer door is called with). */
  expectedLabel: string;
  provide: AskProvide;
  askFingerprint: string;
}

export type OwedProvideAskRefusal =
  | { status: "not_found" }
  | { status: "unknown_label" | "already_done" | "retired" }
  | { status: "ask_changed" }
  | { status: "ask_invalid"; code: "not_provide"; message: string };

/**
 * The slot the person would answer, when its ask is a `provide` — through the
 * SAME owner floor and slot selection the answer door uses, so the options
 * never describe a slot the door would refuse.
 */
export async function loadOwedProvideAsk(p: {
  sessionId: string;
  userId: string;
  expectedLabel: string;
  /** The ask the client rendered; a mismatch is `ask_changed`. */
  askFingerprint?: string;
}): Promise<OwedProvideAsk | OwedProvideAskRefusal> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      eq(focusSessions.userId, p.userId)
    ),
    columns: {
      id: true,
      workspaceId: true,
      projectId: true,
      expectedOutputs: true,
    },
  });
  if (!session) return { status: "not_found" };
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const chosen = selectSlotToAnswer(outputs, p.expectedLabel);
  if ("refused" in chosen) return { status: chosen.refused };
  const slot = outputs[chosen.index]!;
  const ask = effectiveSlotAsk(slot);
  const fingerprint = askFingerprint(ask);
  if (p.askFingerprint !== undefined && p.askFingerprint !== fingerprint) {
    return { status: "ask_changed" };
  }
  if (ask?.mode !== "provide") {
    return {
      status: "ask_invalid",
      code: "not_provide",
      message: "This question does not ask you to hand anything over.",
    };
  }
  return {
    session: {
      id: session.id,
      workspaceId: session.workspaceId,
      projectId: session.projectId,
    },
    expectedLabel: slot.label,
    provide: ask.provide,
    askFingerprint: fingerprint,
  };
}

/** The answer door's own words for a refusal, so both doors read alike. */
export function describeProvideRefusal(
  refusal: OwedProvideAskRefusal,
  expectedLabel: string,
  sessionId: string
): ReturnType<typeof describeAnswerRefusal> {
  return describeAnswerRefusal(
    refusal.status === "ask_invalid"
      ? {
          status: "ask_invalid",
          code: "provide_mismatch",
          message: refusal.message,
        }
      : refusal,
    expectedLabel,
    sessionId
  );
}

// ── Where a file lands ─────────────────────────────────────────────────────

export type ProvideFileLanding =
  | {
      status: "ready";
      workspaceId: string;
      workspaceName: string;
      /** Pass to the upload door so the file is filed into the project too. */
      projectId: string | null;
      /** `session_space` — the session's own; `project_home` — its project's home. */
      via: "session_space" | "project_home";
    }
  | { status: "refused"; message: string };

/**
 * The space a file handed over for this session lands in: the session's own
 * space, else its project's home space, else nowhere (refused in words). The
 * person must be able to write there — the upload door checks the same
 * (`canWriteWorkspace`), so a `ready` answer is one the upload will accept.
 */
export async function resolveProvideFileLanding(p: {
  userId: string;
  session: { workspaceId: string | null; projectId: string | null };
}): Promise<ProvideFileLanding> {
  let workspaceId = p.session.workspaceId;
  let via: "session_space" | "project_home" = "session_space";
  if (!workspaceId && p.session.projectId) {
    const [project] = await db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, p.session.projectId))
      .limit(1);
    workspaceId = project?.workspaceId ?? null;
    via = "project_home";
  }
  if (!workspaceId) {
    return {
      status: "refused",
      message:
        "This session has no space and its project has no home space, so there is nowhere to save the file. Give the session a space first.",
    };
  }
  const [space] = await db
    .select({ name: workspaces.name, archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!space || space.archivedAt) {
    return {
      status: "refused",
      message:
        "The space this file would be saved in is archived or gone. Give the session another space first.",
    };
  }
  if (!(await canWriteWorkspace(p.userId, workspaceId))) {
    return {
      status: "refused",
      message: `You can't add files to ${space.name}. Ask its owner, or give the session a space you can write to.`,
    };
  }
  return {
    status: "ready",
    workspaceId,
    workspaceName: space.name,
    projectId: p.session.projectId,
    via,
  };
}

// ── The options ─────────────────────────────────────────────────────────────

export interface ProvideSecretRow {
  /** The answer's reference (`vault://<id>`). */
  ref: string;
  name: string;
  type: string;
}

export interface ProvideConnectionRow {
  /** The answer's `connectionId` (the registry row). */
  id: string;
  label: string;
  /** Which account of the service, when the pod knows one. */
  accountHint: string | null;
  podWide: boolean;
  isDefault: boolean;
  needsReauth: boolean;
}

export type ProvideOptions = {
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
} & (
  | {
      kind: "secret";
      secret: {
        name: string;
        rows: ProvideSecretRow[];
        /** What handing one over lets the asking agent do. */
        grant: ProvideSecretGrantOffer;
      };
    }
  | {
      kind: "connection";
      connection: {
        service: string;
        serviceName: string;
        /** The integration key to start a connection with; `null` = none here. */
        providerId: string | null;
        connectable: boolean;
        /** Why a new connection can't start here (`connectable` false). */
        unavailable: ProvideConnectUnavailableReason | null;
        rows: ProvideConnectionRow[];
        /** Several accounts: the person confirms which one before it goes. */
        confirmAccount: boolean;
      };
    }
  | {
      kind: "file";
      file: { accept: string[] | null; landing: ProvideFileLanding };
    }
);

export async function readProvideOptions(
  owed: OwedProvideAsk,
  userId: string
): Promise<ProvideOptions> {
  const base = {
    sessionId: owed.session.id,
    expectedLabel: owed.expectedLabel,
    askFingerprint: owed.askFingerprint,
  };
  const provide = owed.provide;
  switch (provide.kind) {
    case "secret": {
      const [rows, agent] = await Promise.all([
        ownSecretRows(userId),
        resolveAskingAgent({
          sessionId: owed.session.id,
          expectedLabel: owed.expectedLabel,
          askFingerprint: owed.askFingerprint,
        }),
      ]);
      return {
        ...base,
        kind: "secret",
        secret: {
          name: provide.name,
          rows,
          grant: agent
            ? {
                status: "will_grant",
                agentUserId: agent.agentUserId,
                agentName: agent.agentName,
                minutes: PROVIDE_SECRET_GRANT_MINUTES,
              }
            : { status: "no_grant", reason: "agent_unknown" },
        },
      };
    }
    case "connection": {
      const [rows, provider] = await Promise.all([
        usableConnectionRows(userId, provide.service),
        resolveProvideProvider(provide.service),
      ]);
      return {
        ...base,
        kind: "connection",
        connection: {
          service: provide.service,
          serviceName: resolveServiceName(provide.service),
          providerId: provider.status === "ok" ? provider.providerId : null,
          connectable: provider.status === "ok",
          unavailable: provider.status === "ok" ? null : provider.status,
          rows,
          confirmAccount: rows.length > 1,
        },
      };
    }
    case "file":
      return {
        ...base,
        kind: "file",
        file: {
          accept: provide.accept ?? null,
          landing: await resolveProvideFileLanding({
            userId,
            session: owed.session,
          }),
        },
      };
  }
}

/**
 * The person's own vault entries an agent could be granted: server-encrypted
 * (a legacy client row cannot be read by the pod) and not a connection
 * pointer (those are handed over as connections).
 */
async function ownSecretRows(userId: string): Promise<ProvideSecretRow[]> {
  const rows = await db
    .select({ id: secrets.id, name: secrets.name, type: secrets.type })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, userId),
        isNull(secrets.deletedAt),
        isNull(secrets.capabilityId),
        eq(secrets.encryptionMode, "server")
      )
    )
    .orderBy(asc(secrets.name));
  return rows.map((r) => ({
    ref: `vault://${r.id}`,
    name: r.name,
    type: r.type,
  }));
}

/**
 * The connections the person can hand over for `service`: a capability
 * connection row they own or that is pod-wide (`checkProvideRef`'s floor),
 * whose capability IS that service — by its Nango provider, its template key
 * or its name.
 */
async function usableConnectionRows(
  userId: string,
  service: string
): Promise<ProvideConnectionRow[]> {
  const rows = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      accountHint: secrets.accountHint,
      isPodWide: secrets.isPodWide,
      isDefault: secrets.isDefault,
      connectionState: secrets.connectionState,
      capabilityId: secrets.capabilityId,
    })
    .from(secrets)
    .where(
      and(
        isNotNull(secrets.capabilityId),
        isNull(secrets.deletedAt),
        or(eq(secrets.userId, userId), eq(secrets.isPodWide, true))
      )
    )
    .orderBy(asc(secrets.createdAt));
  if (rows.length === 0) return [];
  const capabilityIds = [...new Set(rows.map((r) => r.capabilityId!))];
  const matching = await capabilitiesForService(capabilityIds, service);
  return rows
    .filter((r) => matching.has(r.capabilityId!))
    .map((r) => ({
      id: r.id,
      label: r.name,
      accountHint: r.accountHint,
      podWide: r.isPodWide,
      isDefault: r.isDefault,
      needsReauth: r.connectionState === "needs_reauth",
    }));
}

async function capabilitiesForService(
  capabilityIds: string[],
  service: string
): Promise<Set<string>> {
  const [caps, edges] = await Promise.all([
    db
      .select({
        id: capabilities.id,
        name: capabilities.name,
        templateKey: capabilities.templateKey,
      })
      .from(capabilities)
      .where(inArray(capabilities.id, capabilityIds)),
    db
      .select({ capabilityId: links.toId, toolId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "tool"),
          eq(links.linkType, "member_of"),
          eq(links.toType, "capability"),
          inArray(links.toId, capabilityIds)
        )
      ),
  ]);
  const memberTools =
    edges.length === 0
      ? []
      : await db
          .select({
            id: tools.id,
            credentialRef: tools.credentialRef,
            config: tools.config,
          })
          .from(tools)
          .where(
            inArray(
              tools.id,
              edges.map((e) => e.toolId)
            )
          );
  const providerOfTool = new Map(
    memberTools.map((t) => [t.id, providerConfigKeyOf(t)])
  );
  const matching = new Set<string>();
  for (const c of caps) {
    if (sameService(c.templateKey, service) || sameService(c.name, service)) {
      matching.add(c.id);
    }
  }
  for (const e of edges) {
    if (sameService(providerOfTool.get(e.toolId), service)) {
      matching.add(e.capabilityId);
    }
  }
  return matching;
}
