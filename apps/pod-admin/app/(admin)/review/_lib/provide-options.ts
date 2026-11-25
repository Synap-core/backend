/**
 * A `provide` ask's sheet in Review — what the person can hand over, shaped
 * from the pod's one read (`focusSessions.provideOptions`), and the receipt
 * once it went.
 *
 * PURE. The pod decides which secrets, connections and spaces apply (owner
 * floored, the same floor as the answer door); the words and the account rules
 * are `@synap-core/types/ask`'s, the ones the desktop and phone apps apply.
 * What is left here is the console's arrangement:
 *
 *   secret     → pick one of the person's EXISTING vault secrets. The console
 *                never takes a new one: that is added in the app.
 *   connection → use an account already connected (with several, the person
 *                confirms which, nothing pre-picked; a signed-out one is shown
 *                but never handed over), or connect a new one.
 *   file       → upload into the space the pod named, or its refusal, plainly.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  ASK_COPY,
  provideAccountChoices,
  provideExpectedGranteeId,
  providePrePickedAccount,
  provideSecretAccessLine,
  type AskProvideKind,
  type ProvideAccountChoice,
  type ProvideSecretGrant,
  type ProvideSecretGrantOffer,
  type ProvideSecretUses,
  type ProvideStandingGrant,
  provideSecretUsesMinutes,
} from "@synap-core/types/ask";
import type { ProvideSecretUse } from "../../../_lib/request/api";

export type ProvideOptions =
  inferRouterOutputs<AppRouter>["focusSessions"]["provideOptions"];

type Of<K extends ProvideOptions["kind"]> = Extract<
  ProvideOptions,
  { kind: K }
>;

// ─── Secret ──────────────────────────────────────────────────────────────────

export interface SecretChoice {
  /** The answer's reference (`vault://<id>`). */
  ref: string;
  name: string;
  type: string;
  /**
   * The asking agent ALREADY holds a permanent grant on this secret: handing
   * it over writes nothing new (finding ebc40493). Null = a new bounded read.
   */
  standingGrant: ProvideStandingGrant | null;
}

/** What the agent declared it will do with the secret (`provide.purpose`). */
export interface SecretPurposeView {
  for: string;
  tool: string;
  action: string | null;
  on: string | null;
}

export interface SecretSheet {
  kind: "secret";
  /** The secret the agent named. */
  name: string;
  choices: SecretChoice[];
  /** Pre-picked: the one whose name is the asked name, when exactly one is. */
  initialRef: string | null;
  /**
   * The agent the card names, sent back on the answer: the pod grants the
   * read only if that agent is still the one asking.
   */
  expectedGranteeId: string | null;
  /** The pod's offer: who will read it, for how long. */
  grant: ProvideSecretGrantOffer;
  /** The agent that will read it; null = no agent can yet. */
  agentName: string | null;
  /** What the agent said it is for; null = it did not say (never inferred). */
  purpose: SecretPurposeView | null;
  /** The reads the ask asked for: the card's default (`This session only`). */
  uses: ProvideSecretUses;
}

/**
 * The honest secret card for the pick (plan d717d6ac §4): what the agent
 * declared, who reads it, and for how long. A standing grant on the picked
 * secret is said as such, never as an hour. The words are the component's;
 * the facts are here.
 */
export interface SecretCardView {
  purpose: SecretPurposeView | null;
  usedBy: string | null;
  /** How long the read lasts: a new `once` / `session` read, or `standing`; null = no agent can read it yet. */
  until: "once" | "session" | "standing" | null;
  /** The person may pick once or session (a new grant to an agent). */
  canPickUses: boolean;
  /** The minutes a new grant of the picked reads lasts at most. */
  minutes: number;
}

export function secretCard(
  sheet: SecretSheet,
  pickedRef: string | null,
  uses: ProvideSecretUses
): SecretCardView {
  const picked = sheet.choices.find((c) => c.ref === pickedRef) ?? null;
  const grants = sheet.grant.status === "will_grant";
  const standing = grants && !!picked?.standingGrant;
  return {
    purpose: sheet.purpose,
    usedBy: sheet.agentName,
    until: !grants ? null : standing ? "standing" : uses,
    canPickUses: grants && !standing,
    minutes: provideSecretUsesMinutes(uses),
  };
}

function secretSheet(o: Of<"secret">): SecretSheet {
  const wanted = o.secret.name.trim().toLowerCase();
  const named = o.secret.rows.filter(
    (r) => r.name.trim().toLowerCase() === wanted
  );
  return {
    kind: "secret",
    name: o.secret.name,
    choices: o.secret.rows.map((r) => ({
      ref: r.ref,
      name: r.name,
      type: r.type.replace(/[_-]+/g, " "),
      standingGrant: r.standingGrant ?? null,
    })),
    initialRef: named.length === 1 ? named[0].ref : null,
    expectedGranteeId: provideExpectedGranteeId(o.secret.grant),
    grant: o.secret.grant,
    agentName:
      o.secret.grant.status === "will_grant" ? o.secret.grant.agentName : null,
    purpose: o.secret.purpose
      ? {
          for: o.secret.purpose.for,
          tool: o.secret.purpose.tool,
          action: o.secret.purpose.action ?? null,
          on: o.secret.purpose.on ?? null,
        }
      : null,
    uses:
      (o.secret.grant.status === "will_grant" ? o.secret.grant.uses : null) ??
      "session",
  };
}

// ─── Connection ──────────────────────────────────────────────────────────────

export interface ConnectionSheet {
  kind: "connection";
  serviceName: string;
  /** Every account; one that is not `usable` is shown but can't be picked. */
  choices: ProvideAccountChoice[];
  /** Several accounts: the person picks one, nothing is pre-picked. */
  confirmAccount: boolean;
  initialId: string | null;
  /** The integration a new connection starts with; null = none here. */
  connectProviderId: string | null;
  /** Why a new connection can't start here, in words. */
  unavailable: string | null;
}

function connectionSheet(o: Of<"connection">): ConnectionSheet {
  const c = o.connection;
  const choices = provideAccountChoices(c.rows);
  return {
    kind: "connection",
    serviceName: c.serviceName,
    choices,
    confirmAccount: c.confirmAccount,
    initialId: providePrePickedAccount(choices, c.confirmAccount)?.id ?? null,
    connectProviderId: c.connectable ? c.providerId : null,
    unavailable: c.unavailable
      ? ASK_COPY.provideConnectUnavailable(c.unavailable, c.serviceName)
      : null,
  };
}

// ─── File ────────────────────────────────────────────────────────────────────

/** Where an upload goes — the pod's `landing`, as the upload door takes it. */
export interface FileLanding {
  workspaceId: string;
  projectId: string | null;
}

export interface FileSheet {
  kind: "file";
  accept: string[] | null;
  landing:
    | ({
        ok: true;
        landsIn: string;
        /**
         * Said with a refused answer after the upload went through: the file
         * stays saved in the space, the refusal does not take it back.
         */
        keptIfRefused: string;
      } & FileLanding)
    | { ok: false; message: string };
}

function fileSheet(o: Of<"file">): FileSheet {
  const l = o.file.landing;
  return {
    kind: "file",
    accept: o.file.accept && o.file.accept.length > 0 ? o.file.accept : null,
    landing:
      l.status === "ready"
        ? {
            ok: true,
            workspaceId: l.workspaceId,
            projectId: l.projectId,
            landsIn: ASK_COPY.provideLandsIn(l.workspaceName),
            keptIfRefused: ASK_COPY.provideUploadKept(l.workspaceName),
          }
        : { ok: false, message: l.message },
  };
}

// ─── The sheet ───────────────────────────────────────────────────────────────

export type ProvideSheet = SecretSheet | ConnectionSheet | FileSheet;

export function provideSheet(o: ProvideOptions): ProvideSheet {
  switch (o.kind) {
    case "secret":
      return secretSheet(o);
    case "connection":
      return connectionSheet(o);
    case "file":
      return fileSheet(o);
  }
}

// ─── The receipt ─────────────────────────────────────────────────────────────

export interface ProvideReceipt {
  title: string;
  description?: string;
  /** It went, but not as the person was told (the toast says so). */
  color?: "warning";
}

/**
 * What the person is told once it went. A secret's receipt says who can now
 * read it: the asking agent for the next minutes, in this session, or no
 * agent yet — the pod's own line, never a guess. When the agent asking
 * changed since the person was shown who would read it, the pod gave nobody
 * a read, and the receipt says that instead.
 */
export function provideReceipt(
  kind: AskProvideKind,
  result: { secretGrant?: ProvideSecretGrant },
  now: number
): ProvideReceipt {
  switch (kind) {
    case "secret":
      if (
        result.secretGrant?.status === "refused" &&
        result.secretGrant.reason === "agent_changed"
      ) {
        return {
          title: ASK_COPY.provideAgentChangedTitle,
          description: ASK_COPY.provideAgentChangedBody,
          color: "warning",
        };
      }
      return {
        title: "Secret handed over",
        description: provideSecretAccessLine(
          result.secretGrant ?? { status: "failed" },
          now
        ),
      };
    case "connection":
      return { title: "Connection handed over" };
    case "file":
      return { title: "File handed over" };
  }
}

/** The connect-and-answer receipt: the pod answered the slot itself. */
export function connectedReceipt(serviceName: string): ProvideReceipt {
  return {
    title: `${serviceName} connected`,
    description: "Your answer went to the agent.",
  };
}

// ─── What became of a secret ────────────────────────────────────────────────

/**
 * Where a handed-over secret stands, from the pod's own fields
 * (`focusSessions.provideSecretUse`): still readable (with the grant Take
 * back revokes, and whether it is a STANDING one the agent held before this
 * ask), taken back (only when `revokedAt` is set), used up (`useCount >=
 * maxUses`), or ended at its expiry. Never "Taken back" for a grant that
 * only ran out.
 */
export type SecretUseState =
  | { kind: "active"; grantId: string; standing: boolean }
  | { kind: "takenBack" }
  | { kind: "usedUp" }
  | { kind: "ended"; at: string | null };

export function secretUseState(use: ProvideSecretUse): SecretUseState {
  if (use.revokedAt) return { kind: "takenBack" };
  if (use.active && use.takeBack) {
    return {
      kind: "active",
      grantId: use.takeBack.grantId,
      standing: use.uses === "standing",
    };
  }
  if (use.maxUses !== null && use.useCount >= use.maxUses)
    return { kind: "usedUp" };
  return { kind: "ended", at: use.expiresAt };
}
