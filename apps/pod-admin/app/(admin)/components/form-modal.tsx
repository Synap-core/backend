"use client";

/**
 * `FormModal` — a small form in a dialog: its fields, one submit, the error
 * under the fields. Enter submits; while the call runs the dialog cannot be
 * dismissed, so a half-done write is never hidden behind a closed modal.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import type { FormEvent, ReactNode } from "react";

export function FormModal({
  title,
  submitLabel,
  isPending,
  canSubmit,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  isPending: boolean;
  canSubmit: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      radius="lg"
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      hideCloseButton={isPending}
    >
      <ModalContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (canSubmit && !isPending) onSubmit();
          }}
        >
          <ModalHeader className="pb-2">
            <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
          </ModalHeader>
          <ModalBody className="gap-3 pb-2">
            {children}
            {error && (
              <p role="alert" className="text-[12.5px] text-status-down">
                {error}
              </p>
            )}
          </ModalBody>
          <ModalFooter className="gap-2">
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
              type="submit"
              color="primary"
              radius="md"
              size="sm"
              isLoading={isPending}
              isDisabled={!canSubmit}
            >
              {submitLabel}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
