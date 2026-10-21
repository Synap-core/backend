"use client";

/**
 * The key dialogs that are more than a confirm: Create (kind, scopes, the
 * grant role, lifetime) and Reveal (the plaintext, shown exactly once after a
 * create or rotate).
 */

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Snippet,
  useDisclosure,
} from "@heroui/react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { GRANT_PRESETS, type GrantMintInput } from "@synap-core/types/grants";
import {
  GrantRolePicker,
  keyMintFromRole,
  roleSetsLifetime,
  useGrantRoleOptions,
} from "./grant-role-picker";
import { KEY_EXPIRY_OPTIONS, useOfferedKeyScopes } from "./key-scopes";

export type CreateKeyInput = {
  kind: "personal" | "system";
  keyName: string;
  scope: string[];
  /** null = never; a personal key omitted = 90 days. */
  expiresInDays?: number | null;
  /** Personal keys only (required there): what it may touch. */
  grant?: GrantMintInput["grant"];
};

export function CreateKeyModal({
  isPending,
  onClose,
  onConfirm,
}: {
  isPending: boolean;
  onClose: () => void;
  onConfirm: (input: CreateKeyInput) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [kind, setKind] = useState<"personal" | "system">("personal");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [expiry, setExpiry] = useState<string>("90");
  const {
    roles,
    isError: rolesFailed,
    refetch: refetchRoles,
  } = useGrantRoleOptions();
  const [roleId, setRoleId] = useState<string>(GRANT_PRESETS[0].id);
  const expiresInDays = expiry === "never" ? null : Number(expiry);
  const minted =
    kind === "personal"
      ? keyMintFromRole(roleId, roles, { expiresInDays })
      : undefined;
  const roleLifetime = kind === "personal" && roleSetsLifetime(roleId, roles);

  function toggle(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  const availableScopes = useOfferedKeyScopes(kind);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(52, 211, 153, 0.18)" }}
          >
            <KeyRound className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">New API key</span>
        </ModalHeader>
        <ModalBody className="gap-4 pb-2">
          {/* Key kind */}
          <div className="grid grid-cols-2 gap-2">
            {(["personal", "system"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setScopes(
                    k === "system"
                      ? ["hub-protocol.read", "hub-protocol.write"]
                      : ["data.read"]
                  );
                }}
                className={[
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  kind === k
                    ? "border-primary/40 bg-primary/[0.07] ring-1 ring-inset ring-primary/30"
                    : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
                ].join(" ")}
              >
                <span className="text-[12.5px] font-medium text-foreground capitalize">
                  {k}
                </span>
                <span className="text-[11px] text-foreground/65">
                  {k === "personal"
                    ? "Your personal access token (synap_user_)"
                    : "For automation & scripts — CLI/Raycast use /admin/connect"}
                </span>
              </button>
            ))}
          </div>

          <Input
            label="Key name"
            placeholder={
              kind === "system" ? "e.g. n8n automation" : "e.g. Raycast laptop"
            }
            value={name}
            onValueChange={setName}
            size="sm"
            isRequired
          />
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-foreground">
              Scopes
            </p>
            <div className="flex flex-wrap gap-1.5">
              {availableScopes.map((s) => {
                const active = scopes.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggle(s)}
                    className={[
                      "rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors",
                      active
                        ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40"
                        : "bg-foreground/[0.05] text-foreground/65 hover:bg-foreground/[0.08]",
                    ].join(" ")}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          {kind === "personal" ? (
            <GrantRolePicker
              value={roleId}
              onChange={setRoleId}
              roles={roles}
              minted={minted}
              scopes={scopes}
              rolesFailed={rolesFailed}
              onRetryRoles={refetchRoles}
              isDisabled={isPending}
            />
          ) : null}
          {/* A role with its own lifetime sets it; the summary line says when. */}
          {roleLifetime ? null : (
            <Select
              label="Expires in"
              size="sm"
              selectedKeys={[expiry]}
              onSelectionChange={(keys) => {
                const k = Array.from(keys as Set<string>)[0];
                if (k) setExpiry(k);
              }}
            >
              {KEY_EXPIRY_OPTIONS.map((o) => (
                <SelectItem key={o.key}>{o.label}</SelectItem>
              ))}
            </Select>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            size="sm"
            radius="md"
            isDisabled={
              !name.trim() ||
              scopes.length === 0 ||
              (kind === "personal" && !minted) ||
              isPending
            }
            isLoading={isPending}
            onPress={() =>
              void onConfirm({
                kind,
                keyName: name.trim(),
                scope: scopes,
                expiresInDays: minted ? minted.expiresInDays : expiresInDays,
                ...(minted ? { grant: minted.grant } : {}),
              })
            }
          >
            Create
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Reveal modal — shown ONCE on create / rotate ─────────────────────────

export function RevealKeyModal({
  keyName,
  plaintext,
  note,
  onClose,
}: {
  keyName: string;
  plaintext: string;
  note: "created" | "rotated";
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
