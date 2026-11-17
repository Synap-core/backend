"use client";

/**
 * THE DECISION BAR of every request (an agent's ask, a proposal): the
 * story's own footer (`RequestStoryView` `footer`), pinned by its host to
 * the bottom of the scroll box, on the card's own surface. It holds, in this
 * order: the verbs (or what was decided), what refusing does, and who
 * decides ("You decide as … · recorded in the Audit log").
 *
 * One component for both kinds of request (UX review M1 / M2): before it, a
 * proposal's bar sat inside Now and cut the rail, and an ask had none.
 */

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { navItem } from "../../../lib/console-nav";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";
import { proposalPageT } from "../../proposal/[id]/copy";
import { STORY_FOOTER } from "./request-story-view";

/**
 * Where a control's verbs go: the bar's verb row, when a host draws the bar.
 * A control whose verb needs its own state (an ask's Give, holding the
 * picked secret and how long) draws it through `InDecisionBar`; it lands in
 * the bar, beside Refuse, and stays wired to its control.
 */
export const DecisionBarSlot = createContext<HTMLElement | null>(null);

/** The control's verb row: in the decision bar when there is one, else in place. */
export function InDecisionBar({ children }: { children: ReactNode }) {
  const slot = useContext(DecisionBarSlot);
  const row = (
    <div data-review-verbs="" className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
  return slot ? createPortal(row, slot) : row;
}

/** "You decide as <name> · recorded in the Audit log" — the log a door for an admin. */
function WhoDecides({ identity }: { identity?: string }) {
  const role = useConsoleRole();
  const audit = navItem("audit");
  const log =
    role === "admin" ? (
      <a
        href={audit.href}
        className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-foreground/70"
      >
        {audit.label}
      </a>
    ) : (
      audit.label
    );
  const t = proposalPageT();
  return (
    <p className="text-[12px] text-foreground/70">
      {identity ? t("decide.as", { identity }) : t("decide.recorded")} {log}
    </p>
  );
}

export function DecisionFooter({
  verbs,
  consequence,
  identity,
  verbsSlot,
  className = "",
}: {
  /** The verbs, or what was decided. */
  verbs?: ReactNode;
  /** What refusing does, one sentence. */
  consequence?: ReactNode;
  /** Who the reader is signed in as, when the host knows it. */
  identity?: string;
  /** Where a control draws its own verb row (`InDecisionBar`), before `verbs`. */
  verbsSlot?: (el: HTMLDivElement | null) => void;
  /** The host's pin (its `bottom`, bleed and padding). */
  className?: string;
}) {
  return (
    <div data-review-decision="" className={`${STORY_FOOTER} ${className}`}>
      {verbsSlot && <div ref={verbsSlot} className="contents" />}
      {verbs}
      {consequence && (
        <p data-review-refusing="" className="text-[12.5px] text-foreground/80">
          {consequence}
        </p>
      )}
      <WhoDecides identity={identity} />
    </div>
  );
}
