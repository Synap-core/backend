"use client";

/**
 * The two dialogs a computer's page opens: Rename, and Change key lifetime.
 * Both write through `machines.*`, which let the computer's owner or a pod
 * admin act (`loadManageableMachine`) — the same doors from `/computers` and
 * `/my-computers`, so one dialog serves both.
 */

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  addToast,
} from "@heroui/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { days, validKeyTtl, type ComputerLike } from "./computer-model";

/** A small form in a dialog: one submit, its error under the fields. */
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

/** The failure in words a person can act on, else a plain fallback. */
function failureText(err: { message: string }, fallback: string): string {
  return readableError(err.message) ?? fallback;
}

export function RenameComputerModal({
  computer,
  onClose,
}: {
  computer: Pick<ComputerLike, "id" | "name">;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(computer.name);
  const [error, setError] = useState<string | null>(null);
  const rename = trpc.machines.rename.useMutation({
    onSuccess: async () => {
      // Its agents' names follow ("Claude Code on <name>"): both rosters.
      await Promise.all([
        utils.machines.invalidate(),
        utils.agentUsers.list.invalidate(),
      ]);
      addToast({ title: "Computer renamed", color: "default" });
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setError(failureText(err, "Couldn't rename it. Try again."));
    },
  });
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 80;
  return (
    <FormModal
      title="Rename this computer"
      submitLabel="Rename"
      isPending={rename.isPending}
      canSubmit={valid && trimmed !== computer.name}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        rename.mutate({ machineId: computer.id, name: trimmed });
      }}
    >
      <Input
        autoFocus
        label="Name"
        size="sm"
        value={name}
        onValueChange={setName}
        maxLength={80}
        isInvalid={!valid}
        errorMessage="1 to 80 characters"
        description="Its agents take the new name too — “Claude Code on <name>”."
      />
    </FormModal>
  );
}

type LifetimeChoice = "default" | "custom";

export function ComputerKeyLifetimeModal({
  computer,
  podDefaultDays,
  onClose,
}: {
  computer: Pick<
    ComputerLike,
    | "id"
    | "name"
    | "keyTtlDays"
    | "effectiveKeyTtlDays"
    | "minKeyTtlDays"
    | "maxKeyTtlDays"
  >;
  /** The pod default, when the viewer may read it (pod admins). */
  podDefaultDays?: number | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [choice, setChoice] = useState<LifetimeChoice>(
    computer.keyTtlDays === null ? "default" : "custom"
  );
  const [draft, setDraft] = useState(String(computer.effectiveKeyTtlDays));
  const [error, setError] = useState<string | null>(null);
  const setTtl = trpc.machines.setKeyTtl.useMutation({
    onSuccess: async (_res, input) => {
      await utils.machines.invalidate();
      addToast({
        title: "Key lifetime saved",
        description:
          input.keyTtlDays === null
            ? "New keys on this computer follow the pod default."
            : `New keys on this computer last ${days(input.keyTtlDays)}.`,
        color: "default",
      });
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setError(failureText(err, "Couldn't save the lifetime. Try again."));
    },
  });

  const value = Number(draft);
  const valid = choice === "default" || validKeyTtl(value, computer);
  const changed =
    choice === "default"
      ? computer.keyTtlDays !== null
      : computer.keyTtlDays !== value;
  // When the computer follows the default, its effective lifetime IS it.
  const podDefault =
    podDefaultDays ??
    (computer.keyTtlDays === null ? computer.effectiveKeyTtlDays : null);

  return (
    <FormModal
      title="Change key lifetime"
      submitLabel="Save"
      isPending={setTtl.isPending}
      canSubmit={valid && changed}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        setTtl.mutate({
          machineId: computer.id,
          keyTtlDays: choice === "default" ? null : value,
        });
      }}
    >
      <p className="text-[12.5px] leading-relaxed text-foreground/65">
        How long a key made for {computer.name} and its agents lasts. The
        computer renews its key before then; the keys it holds now keep their
        expiry.
      </p>
      <RadioGroup
        aria-label="Key lifetime"
        value={choice}
        onValueChange={(v) => setChoice(v as LifetimeChoice)}
        size="sm"
      >
        <Radio value="default">
          {podDefault !== null
            ? `Pod default (${days(podDefault)})`
            : "Pod default"}
        </Radio>
        <Radio value="custom">Just for this computer</Radio>
      </RadioGroup>
      {choice === "custom" && (
        <Input
          type="number"
          size="sm"
          label="Days"
          className="max-w-40"
          min={computer.minKeyTtlDays}
          max={computer.maxKeyTtlDays}
          value={draft}
          onValueChange={setDraft}
          isInvalid={!valid}
          errorMessage={`${computer.minKeyTtlDays}–${computer.maxKeyTtlDays} days`}
          description={`${computer.minKeyTtlDays}–${computer.maxKeyTtlDays} days`}
        />
      )}
    </FormModal>
  );
}
