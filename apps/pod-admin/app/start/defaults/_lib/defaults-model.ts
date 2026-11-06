/**
 * The defaults step (`/start/defaults`, founder 5 Nov 2026, session
 * b064a220): the pod's notable defaults as ONE short list of switches the
 * owner may change in one go. Pure, so each state is tested; the view only
 * draws what this decides.
 *
 * Each row is a setting that has a default AND its own door; the step never
 * writes a setting itself (no second setter). The rows, in order:
 *  - presence:    `presence.mode` / `presence.setMode` (ON by default; OFF
 *                 asks for a proof; the operator's env floor locks it ON);
 *  - reversible:  `governanceRules.reversibleDefault` / `setReversibleDefault`;
 *  - ownOrganise: `governanceRules.ownOrganiseDefault` / `setOwnOrganiseDefault`;
 *  - proactive:   `proactive.getPodDefaults` / `setPodDefaults` (its `enabled`;
 *                 the rest is sent back as read);
 *  - library:     `proactive.getLibraryKeepAlive` / `setLibraryKeepAlive`.
 *
 * A failed READ is the row's failed mark with Try again, never a calm switch:
 * an empty result and a failed read are different facts. A row the pod says
 * this person may not change is drawn locked, with why.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  dialState,
  type DialQuery,
  type DialSave,
  type DialState,
} from "../../../(admin)/settings/review/_lib/pod-defaults-model";
import type { QueryLike } from "../../../proposal/[id]/proposal-session-model";

export type { QueryLike };

export const DEFAULT_ROWS = [
  "presence",
  "reversible",
  "ownOrganise",
  "proactive",
  "library",
] as const;
export type DefaultRow = (typeof DEFAULT_ROWS)[number];

type Outputs = inferRouterOutputs<AppRouter>;

/** `presence.mode` (the fields this step reads). */
export type PresenceModeData = Pick<
  Outputs["presence"]["mode"],
  "mode" | "source"
>;

/** `presence.factors`: the person's passkeys and Relay device keys. */
export type PresenceFactorsData = Outputs["presence"]["factors"];

/** `proactive.getPodDefaults` (the fields this step reads and sends back). */
export type ProactiveDefaultsData = Pick<
  Outputs["proactive"]["getPodDefaults"],
  "defaults"
>;

/** `proactive.getLibraryKeepAlive` (the fields this step reads). */
export type LibraryKeepAliveData = Pick<
  Outputs["proactive"]["getLibraryKeepAlive"],
  "settings"
>;

function dial<T>(
  read: QueryLike<T>,
  toDial: (data: T) => { enabled: boolean; canManage: boolean }
): DialQuery {
  const failed = read.error != null;
  return {
    isLoading: read.isLoading,
    isError: failed,
    data: failed || read.data === undefined ? undefined : toDial(read.data),
  };
}

/** The presence mode as a switch: ON is `enforce`; the env floor locks it. */
export function presenceDial(read: QueryLike<PresenceModeData>): DialQuery {
  return dial(read, (d) => ({
    enabled: d.mode === "enforce",
    canManage: d.source !== "env",
  }));
}

/** Proactive AI as a switch. The page is pod-admin only, as is its door. */
export function proactiveDial(
  read: QueryLike<ProactiveDefaultsData>
): DialQuery {
  return dial(read, (d) => ({ enabled: d.defaults.enabled, canManage: true }));
}

/** The Library keep-alive as a switch. Pod-admin only, as is its door. */
export function libraryDial(read: QueryLike<LibraryKeepAliveData>): DialQuery {
  return dial(read, (d) => ({ enabled: d.settings.enabled, canManage: true }));
}

/**
 * What `proactive.setPodDefaults` is sent when only the switch moves: the
 * defaults as READ, with `enabled` changed. Never a guessed object: with no
 * read there is no switch to move (the row is loading or failed).
 */
export function proactiveInput(
  read: ProactiveDefaultsData,
  enabled: boolean
): ProactiveDefaultsData["defaults"] {
  return { ...read.defaults, enabled };
}

export type DefaultRowView = {
  row: DefaultRow;
  state: DialState;
  /** Why the switch cannot move, when the pod says so. */
  lockedBy: "operator" | "admin" | null;
};

/** The step's rows, in order, from each setting's read and its last save. */
export function defaultsStepRows(
  dials: Record<DefaultRow, { read: DialQuery; save: DialSave }>,
  presenceRead: QueryLike<PresenceModeData>
): DefaultRowView[] {
  return DEFAULT_ROWS.map((row) => {
    const state = dialState(dials[row].read, dials[row].save);
    const lockedBy =
      state.kind !== "ready" || state.canManage
        ? null
        : row === "presence" && presenceRead.data?.source === "env"
          ? "operator"
          : "admin";
    return { row, state, lockedBy };
  });
}

/** `presence.setMode`'s call in flight, as a switch save (`enforce` is ON). */
export function presenceSave(save: {
  isPending: boolean;
  variables?: { mode: "enforce" | "report" } | undefined;
}): DialSave {
  const { isPending, variables } = save;
  return {
    isPending,
    variables: variables
      ? { enabled: variables.mode === "enforce" }
      : undefined,
  };
}

/** A setter whose input names `enabled` optionally, as a switch save. */
export function enabledSave(save: {
  isPending: boolean;
  variables?: { enabled?: boolean } | undefined;
}): DialSave {
  const { isPending, variables } = save;
  const enabled = variables?.enabled;
  return {
    isPending,
    variables: typeof enabled === "boolean" ? { enabled } : undefined,
  };
}

/**
 * What the presence row says under its switch about the person's own
 * factors: an INVITE to add a passkey when they hold none (a new owner has
 * neither a passkey nor Relay's Face ID, and turning approvals in person off
 * again needs one), a failed read with Try again, or nothing.
 */
export type FactorNote = "none" | "failed" | null;

export function factorNote(read: QueryLike<PresenceFactorsData>): FactorNote {
  if (read.error != null) return "failed";
  if (read.isLoading || !read.data) return null;
  return read.data.passkeys + read.data.deviceKeys === 0 ? "none" : null;
}
