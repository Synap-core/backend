"use client";

/**
 * `ConfirmModal` — the one destructive-confirm shape in pod-admin.
 *
 * Every destructive action in this app already confirmed through a HeroUI
 * modal EXCEPT two revokes, which called the native `window.confirm`. That is
 * not a cosmetic inconsistency: the OS dialog cannot render the consequence
 * copy with any structure, is not themeable, blocks the whole renderer, and
 * looks — accurately — like a page that hasn't been finished. It also reads as
 * less trustworthy at exactly the moment the operator is deciding whether to
 * cut off an integration.
 *
 * It is now actually the one shape: the four hand-rolled confirms that this
 * file's first version claimed to replace but never touched (entity delete,
 * workspace archive, workspace delete, agent revoke/remove) all route through
 * here. Each prop below exists because one of them needed it — a prop with no
 * call site is how `width` shipped inert.
 *
 * Consequence copy is a required prop, not optional. A confirm that only asks
 * "are you sure?" moves the click without informing it.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import type { ReactNode } from "react";

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** What will actually happen. Say it plainly, including what will NOT. */
  consequence: ReactNode;
  /** Imperative, naming the act — "Revoke access", not "OK". */
  confirmLabel: string;
  /**
   * True only while THIS confirmation's mutation is running.
   *
   * Must be scoped to the row being confirmed, not to the mutation object.
   * A shared `mutation.isPending` leaks across rows: dismiss row A mid-flight,
   * open row B, and B's dialog renders already-spinning and already-disabled —
   * then A's `onSuccess` closes B and reports success for a revoke B never
   * fired.
   */
  isPending?: boolean;
  /**
   * Tone of the confirm button. `danger` for anything irreversible; `warning`
   * for a reversible-but-consequential act — workspace archive is the one that
   * needs it, and rendering it red would overstate what it does.
   */
  confirmColor?: "danger" | "warning";
  /**
   * Blocks the confirm without blocking the dialog — for a gate the operator
   * must clear first. Only workspace delete uses it, for its type-the-name
   * input; everything else confirms on the first click.
   */
  isConfirmDisabled?: boolean;
  /**
   * Extra body content under the consequence copy — the type-the-name input,
   * and nothing else today. The gating state stays at the call site; this
   * component owns the shape, not the rule.
   */
  children?: ReactNode;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel,
  isPending = false,
  confirmColor = "danger",
  isConfirmDisabled = false,
  children,
}: ConfirmModalProps) {
  return (
    /* Not dismissable while the mutation is in flight: the modal now stays up
       until the request resolves, so letting it be closed mid-flight would put
       the user back on a list that has not changed yet, with no idea whether
       the revoke landed. */
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      radius="lg"
      /* All THREE dismiss paths must close while a mutation is in flight, not
         two. `isDismissable` governs outside-click only; React Aria puts
         Escape behind `isKeyboardDismissDisabled`, which defaults to allowing
         it. Leaving Escape open let the operator dismiss mid-request and then
         open a SECOND confirm whose state belonged to the first — see the
         `isPending` note at the call sites. */
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      hideCloseButton={isPending}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 pb-2">
          <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
        </ModalHeader>
        <ModalBody className="pb-2">
          <div className="text-[12.5px] leading-relaxed text-foreground/65">
            {consequence}
          </div>
          {children ? <div className="mt-3">{children}</div> : null}
        </ModalBody>
        <ModalFooter className="gap-2">
          {/* Disabled in flight for the same reason `isDismissable` is: the
              modal now deliberately stays up until the mutation resolves, and
              Cancel was the one control that still tore it down mid-request —
              returning the operator to an unchanged list with a revoke still
              running. Blocking Esc and the backdrop but not the button left
              the hole exactly where a user would click. */}
          <Button
            variant="flat"
            radius="md"
            size="sm"
            isDisabled={isPending}
            onPress={onClose}
          >
            Cancel
          </Button>
          <Button
            color={confirmColor}
            variant="solid"
            radius="md"
            size="sm"
            isLoading={isPending}
            isDisabled={isPending || isConfirmDisabled}
            onPress={onConfirm}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
