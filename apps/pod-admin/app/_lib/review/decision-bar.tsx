"use client";

/**
 * The decision bar of a REVIEW page: pinned to the bottom while a decision is
 * open, the verbs (Approve beside "Reject…", which asks once more), and who
 * decides under them. Shared by the proposal review and the key request
 * review (`./review-parts.tsx` says why these parts are one folder).
 */

import type { ReactNode } from "react";
import { Button, Textarea } from "@heroui/react";
import { Check, X } from "lucide-react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { navItem } from "../../../lib/console-nav";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";

/** "Approve", "Reject…": the verbs from the vocabulary door. */
export const APPROVE_LABEL = resolveActionLabel("approve");
export const REJECT_LABEL = `${resolveActionLabel("reject")}…`;

/**
 * The decision bar pinned to the window's bottom on a receiver card: Approve
 * and Reject stay in reach under a long review (a 106-record capture read
 * 34,545 px). Spans the card body's padding, on the card's own ground made
 * opaque (the page under it plus the card's 4% tint), so nothing scrolls
 * visibly beneath it.
 */
export const DECISION_BAR_PIN =
  "bottom-0 -mx-7 bg-background bg-[linear-gradient(hsl(var(--heroui-foreground)/0.04),hsl(var(--heroui-foreground)/0.04))] px-7 py-3";

/**
 * The bar itself: sticky while the decision is open (`pinned`), a plain
 * closing block once it is decided. `className` places it in its host's
 * scroll box (`DECISION_BAR_PIN` on a receiver card).
 */
export function DecisionBar({
  pinned,
  className = "",
  children,
}: {
  pinned: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-review-decision=""
      className={`flex flex-col gap-2 border-t border-foreground/[0.06] ${
        pinned ? "sticky z-10" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** The one primary of a review. */
export function ApproveButton({
  children = APPROVE_LABEL,
  isLoading,
  isDisabled,
  onPress,
}: {
  children?: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      color="success"
      className="min-h-10"
      startContent={<Check size={16} />}
      isLoading={isLoading}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}

/** "Reject…": opens `RejectConfirm`, never rejects on the first press. */
export function RejectButton({
  isDisabled,
  onPress,
}: {
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      color="danger"
      variant="flat"
      className="min-h-10"
      startContent={<X size={16} />}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      {REJECT_LABEL}
    </Button>
  );
}

/**
 * The second step of a reject: an optional reason (only where the door keeps
 * one, `reason`), then "Confirm reject" or Cancel.
 */
export function RejectConfirm({
  reason,
  isLoading,
  onConfirm,
  onCancel,
}: {
  reason?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  };
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {reason && (
        <Textarea
          value={reason.value}
          onValueChange={reason.onChange}
          label="Reason (optional)"
          placeholder={reason.placeholder}
          minRows={2}
        />
      )}
      <div className="flex items-center gap-2">
        <Button
          color="danger"
          className="min-h-10"
          isLoading={isLoading}
          onPress={onConfirm}
        >
          Confirm reject
        </Button>
        <Button
          variant="light"
          className="min-h-10"
          isDisabled={isLoading}
          onPress={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Who decides, and where it is recorded — one quiet line by the verbs. */
export function WhoDecides({ identity }: { identity?: string }) {
  const role = useConsoleRole();
  const audit = navItem("audit");
  const log =
    role === "admin" ? (
      <a
        href={audit.href}
        className="underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground/60"
      >
        {audit.label}
      </a>
    ) : (
      audit.label
    );
  return (
    <p className="text-[11.5px] text-foreground/55">
      {identity ? (
        <>
          You decide as <span className="text-foreground/75">{identity}</span>
          {" · recorded in the "}
        </>
      ) : (
        "Recorded in the "
      )}
      {log}
    </p>
  );
}
