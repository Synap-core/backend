"use client";

/**
 * The trusted-issuer DECISION UI — the scope picker and its approve modal —
 * shared by Review's issuer drawer and the issuers list (`issuers-section`).
 *
 * Approving an issuer is choosing what it may do: `trustedIssuers.approve`
 * REPLACES its scopes with exactly the ones picked here. The scope list is
 * typed from the generated tRPC contract, so this UI cannot offer a scope the
 * pod does not recognise.
 */

import {
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure,
} from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { trpc } from "../../../../lib/trpc";

/** A scope `trustedIssuers.approve` accepts. */
export type TrustedIssuerScope = Parameters<
  ReturnType<typeof trpc.trustedIssuers.approve.useMutation>["mutateAsync"]
>[0]["allowedScopes"][number];

export const ISSUER_SCOPES = [
  {
    value: "auth:exchange-user",
    label: "Sign in linked users",
    description: "Exchange this issuer's identity assertion for a Pod session",
  },
  {
    value: "identity:link-user",
    label: "Link Pod identities",
    description:
      "Link an issuer identity after the user proves direct Pod access",
  },
  {
    value: "membership:grant",
    label: "Manage federated membership",
    description:
      "Create or update scoped Pod membership; grant only to a trusted operator",
  },
  {
    value: "source-config:write",
    label: "Configure data sources",
    description:
      "Create source configuration for an already-linked, locally authorized user",
  },
  {
    value: "setup.agent",
    label: "Setup: Agent",
    description: "Provision agent users on this pod",
  },
  {
    value: "hub-protocol.read",
    label: "Hub: Read",
    description: "Read data via Hub Protocol",
  },
  {
    value: "hub-protocol.write",
    label: "Hub: Write",
    description: "Write data via Hub Protocol",
  },
  {
    value: "data.read",
    label: "Data: Read",
    description: "Read entities & documents",
  },
  {
    value: "data.write",
    label: "Data: Write",
    description: "Write entities & documents",
  },
  {
    value: "provision",
    label: "Provision",
    description: "Full pod provisioning",
  },
  {
    value: "tier_update",
    label: "Tier update",
    description: "Update pod tier",
  },
  { value: "sync", label: "Sync", description: "Pod-to-pod sync" },
] as const satisfies readonly {
  value: TrustedIssuerScope;
  label: string;
  description: string;
}[];

/** What a new issuer is offered by default: sign-in and identity linking only. */
export const DEFAULT_ISSUER_SCOPES: TrustedIssuerScope[] = [
  "auth:exchange-user",
  "identity:link-user",
];

/** Keep only scopes this pod recognises (a fix may name others). */
export function knownIssuerScopes(
  scopes: readonly string[]
): TrustedIssuerScope[] {
  return scopes.filter((s): s is TrustedIssuerScope =>
    ISSUER_SCOPES.some((known) => known.value === s)
  );
}

/** The scope checklist — what the issuer will be allowed to do on this pod. */
export function IssuerScopePicker({
  selected,
  onChange,
  isDisabled,
}: {
  selected: TrustedIssuerScope[];
  onChange: (next: TrustedIssuerScope[]) => void;
  isDisabled?: boolean;
}) {
  function toggle(s: TrustedIssuerScope) {
    onChange(
      selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s]
    );
  }
  return (
    <div>
      <div className="max-h-72 overflow-y-auto rounded-lg ring-1 ring-inset ring-foreground/10">
        {ISSUER_SCOPES.map((s) => (
          <label
            key={s.value}
            className="flex cursor-pointer items-start gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
          >
            <Checkbox
              size="sm"
              isSelected={selected.includes(s.value)}
              isDisabled={isDisabled}
              onValueChange={() => toggle(s.value)}
            />
            <span className="flex flex-col">
              <span className="text-[12.5px] font-medium text-foreground">
                {s.label}
              </span>
              <span className="text-[11px] text-foreground/65">
                {s.description}
              </span>
            </span>
          </label>
        ))}
      </div>
      {selected.length === 0 && (
        <p className="mt-2 text-[11.5px] text-status-down">
          Select at least one scope.
        </p>
      )}
    </div>
  );
}

/** Approve an issuer from a list: its URL, the scope picker, Approve. */
export function IssuerApproveModal({
  issuer,
  initialScopes,
  isPending,
  onClose,
  onConfirm,
}: {
  issuer: { displayName: string; issuerUrl: string };
  /** Pre-selected scopes; `approve` REPLACES the issuer's scopes, so a fix
   * that adds one scope passes the issuer's current scopes plus that one. */
  initialScopes?: TrustedIssuerScope[];
  isPending: boolean;
  onClose: () => void;
  onConfirm: (scopes: TrustedIssuerScope[]) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [selected, setSelected] = useState<TrustedIssuerScope[]>(
    initialScopes ?? DEFAULT_ISSUER_SCOPES
  );

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(52, 211, 153, 0.18)" }}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Approve {issuer.displayName}</span>
        </ModalHeader>
        <ModalBody className="gap-3 pb-2">
          <p className="font-mono text-[11.5px] text-foreground/65">
            {issuer.issuerUrl}
          </p>
          <div>
            <p className="mb-1 text-[12.5px] font-medium text-foreground">
              Allowed scopes
            </p>
            <p className="mb-2 text-[11.5px] text-foreground/65">
              Pick what this issuer is allowed to do on this pod.
            </p>
            <IssuerScopePicker selected={selected} onChange={setSelected} />
          </div>
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
            color="success"
            size="sm"
            radius="md"
            isDisabled={selected.length === 0 || isPending}
            isLoading={isPending}
            onPress={() => void onConfirm(selected)}
          >
            Approve
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
