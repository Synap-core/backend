"use client";

/**
 * What the ask's controls share (`ask-answer.tsx`, `secret-provide.tsx`):
 * the props every control takes, a group label, the radio-as-card, and the
 * door into the app where a new secret is added. Moved out of
 * `ask-answer.tsx` so each control can live in its own file.
 */

import type { ReactNode } from "react";
import type { AskProvideRef } from "@synap-core/types/ask";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { useT } from "../../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "../../../_lib/request/copy";
import type { AskControlView, AskDraft, AskSlot } from "./ask-detail";

export { RADIO_CARD } from "../../../_lib/request/refuse-sheet";

/** A door's error, as tRPC hands it over. */
export type DoorError = {
  message: string;
  data?: { code?: string | null } | null;
};

/** The label over a group of controls, in sentence case (no small caps). */
export const SECTION_LABEL = "text-[12.5px] font-medium text-foreground/75";

export interface ControlsProps {
  slot: AskSlot;
  control: AskControlView;
  busy: boolean;
  /** The answer call is in flight (an answer, not a refusal). */
  pending: boolean;
  /** Returns field errors to show, or null when the answer went out. */
  onAnswer: (draft: AskDraft) => Record<string, string> | null;
  onAttest: () => void;
  attesting: boolean;
  onHandBack: () => void;
  handingBack: boolean;
  /**
   * Hand over a reference (a vault secret, a connection, a file); a secret
   * carries the agent the person was told will read it, an upload what to say
   * if the answer is then refused.
   */
  onProvide: (
    ref: AskProvideRef,
    extras?: {
      expectedGranteeId?: string;
      keptIfRefused?: string;
      secretUses?: "once" | "session";
    }
  ) => void;
  /** A door refused: stale (moved on, changed) or a failure, as the pod said. */
  onStale: (err: DoorError) => void;
  onFailure: (message: string | null) => void;
  /** The pod answered the slot itself with a new connection. */
  onConnected: (serviceName: string) => void;
  /** A secret asked with no purpose: ask the agent what it is for (the room). */
  onAskWhatFor?: () => void;
  /** That question is in the room. */
  askedWhatFor?: boolean;
  /**
   * "Refuse…", drawn beside the control's own verb (a secret's Give) or in
   * the row under it — the same trigger on every mode.
   */
  refuse?: ReactNode;
}

export type ProvideControlProps = ControlsProps & {
  control: Extract<AskControlView, { mode: "provide" }>;
};

/** "Open in app" — where a new secret, or a larger file, is added. */
export function OpenInAppLink({ sessionId }: { sessionId: string }) {
  const t = useT(REQUEST_CATALOGS);
  return (
    <ExitLink
      exit={openIn({
        kind: "objectInApp",
        objectKind: "session",
        id: sessionId,
      })}
      label={t("ask.openInApp")}
    />
  );
}
