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
  provideGrantNote,
  providePrePickedAccount,
  provideSecretAccessLine,
  type AskProvideKind,
  type ProvideAccountChoice,
  type ProvideSecretGrant,
} from "@synap-core/types/ask";

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
}

export interface SecretSheet {
  kind: "secret";
  /** The secret the agent named. */
  name: string;
  choices: SecretChoice[];
  /** Pre-picked: the one whose name is the asked name, when exactly one is. */
  initialRef: string | null;
  /** What handing one over lets the asking agent do. */
  grantNote: string;
  /**
   * The agent named in `grantNote`, sent back on the answer: the pod grants
   * the read only if that agent is still the one asking.
   */
  expectedGranteeId: string | null;
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
    })),
    initialRef: named.length === 1 ? named[0].ref : null,
    grantNote: provideGrantNote(o.secret.grant),
    expectedGranteeId: provideExpectedGranteeId(o.secret.grant),
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
    | ({ ok: true; landsIn: string } & FileLanding)
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
}

/**
 * What the person is told once it went. A secret's receipt says who can now
 * read it: the asking agent for the next minutes, in this session, or no
 * agent yet — the pod's own line, never a guess.
 */
export function provideReceipt(
  kind: AskProvideKind,
  result: { secretGrant?: ProvideSecretGrant },
  now: number
): ProvideReceipt {
  switch (kind) {
    case "secret":
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
