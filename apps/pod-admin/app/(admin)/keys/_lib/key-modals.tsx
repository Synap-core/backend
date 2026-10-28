"use client";

/**
 * Reveal: the plaintext, shown exactly once after a create or rotate (an
 * Island dialog, page grammar §4). Making a key is a page, `/keys/new`.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Snippet,
  useDisclosure,
} from "@heroui/react";
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

// ─── Reveal modal — shown ONCE on create / rotate ─────────────────────────

export function RevealKeyModal({
  keyName,
  plaintext,
  note,
  usage,
  onClose,
}: {
  keyName: string;
  plaintext: string;
  note: "created" | "rotated";
  /** How to use it, for the doors it was made for. */
  usage?: ReactNode;
  onClose: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      isDismissable={false}
      hideCloseButton
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(245, 158, 11, 0.20)" }}
          >
            <ShieldAlert className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">
            {note === "created" ? "Key created" : "Key rotated"}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3 pb-2">
          <p className="text-[12.5px] text-foreground/85">
            Save <span className="font-medium">{keyName}</span> now — this is
            the only time it will be shown.
          </p>
          <Snippet
            symbol=""
            size="sm"
            className="overflow-hidden font-mono"
            classNames={{ base: "bg-foreground/[0.05]" }}
          >
            {plaintext}
          </Snippet>
          <p className="text-[11.5px] text-foreground/65">
            Treat this like a password. Anyone with the key can act on this pod
            within its scopes.
          </p>
          {usage}
        </ModalBody>
        <ModalFooter>
          <Button color="primary" size="sm" radius="md" onPress={onClose}>
            I have saved it
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
