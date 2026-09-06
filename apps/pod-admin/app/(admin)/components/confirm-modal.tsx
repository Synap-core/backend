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
  isPending?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel,
  isPending = false,
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
      isDismissable={!isPending}
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
        </ModalBody>
        <ModalFooter className="gap-2">
          <Button variant="flat" radius="md" size="sm" onPress={onClose}>
            Cancel
          </Button>
          <Button
            color="danger"
            variant="solid"
            radius="md"
            size="sm"
            isLoading={isPending}
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
