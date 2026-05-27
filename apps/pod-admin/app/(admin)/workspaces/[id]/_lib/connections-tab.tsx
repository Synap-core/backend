"use client";

/**
 * Connections tab — outbound webhooks + external connections.
 *
 * Section A — Outbound: "Synap → your backend"
 *   Studio deep-link (workspace-member-gated, not manageable here).
 *
 * Section B — External connections: "Your backend → Synap"
 *   Unified "Add connection" flow covering two auth paths:
 *   • API Key   — generates a hub_inbound key; Bearer token auth
 *   • Trusted JWT Issuer — registers a JWKS endpoint; no shared secret
 */

import {
  addToast,
  Button,
  Checkbox,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Snippet,
  useDisclosure,
} from "@heroui/react";
import {
  ArrowUpFromLine,
  Ban,
  Check,
  ExternalLink,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { trpc, POD_URL } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowSkeleton,
  ResourceRowError,
} from "../../../components/resource-row";
import { studioDeepLinkForWorkspace } from "../../../people/_lib/helpers";

// ─── Scopes ───────────────────────────────────────────────────────────────────

const CONNECTION_SCOPES: {
  value: string;
  label: string;
  description: string;
}[] = [
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
];

const DEFAULT_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string;
  keyName: string;
  keyType?: string | null;
  isActive: boolean;
  createdAt?: Date | string | null;
}

type AuthMethod = "api-key" | "jwt-issuer";
type Step = "method" | "configure" | "success";

interface SuccessApiKey {
  kind: "api-key";
  keyId: string;
  keyName: string;
  plaintext: string;
}

interface SuccessIssuer {
  kind: "jwt-issuer";
  name: string;
  issuerUrl: string;
  allowedScopes: string[];
}

type SuccessPayload = SuccessApiKey | SuccessIssuer;

// ─── Main component ───────────────────────────────────────────────────────────

export function ConnectionsTab({ workspaceId }: { workspaceId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const utils = trpc.useUtils();
  const keysQuery = trpc.apiKeys.adminListAll.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const inboundKeys = useMemo(
    () =>
      ((keysQuery.data as ApiKey[] | undefined) ?? []).filter(
        (k) => k.keyType === "hub_inbound" && k.isActive
      ),
    [keysQuery.data]
  );

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      addToast({ title: "Connection revoked", color: "default" });
      setRevokeTarget(null);
    },
    onError: (err) =>
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      }),
  });

  return (
    <div className="flex flex-col gap-6">
      {/* ── Section A: Outbound ───────────────────────────────────────── */}
      <SectionCard
        title="Outbound webhooks"
        hint="Synap → your backend: POST events to external URLs"
        actions={
          <Button
            as="a"
            href={studioDeepLinkForWorkspace(workspaceId)}
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            variant="flat"
            radius="md"
            endContent={<ExternalLink className="h-3 w-3" />}
          >
            Manage in Studio
          </Button>
        }
      >
        <div className="flex items-start gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-4 py-3 mt-1">
          <ArrowUpFromLine
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40"
            aria-hidden
          />
          <div className="flex flex-col gap-1">
            <p className="text-[12.5px] font-medium text-foreground">
              Outbound webhooks are workspace-member-gated
            </p>
            <p className="text-[11.5px] text-foreground/55">
              Members manage subscriptions in Studio → Settings → Webhooks. Pod
              Admin doesn't hold workspace credentials, so the list is read from
              Studio.
            </p>
          </div>
        </div>
      </SectionCard>

      {/* ── Section B: External connections ──────────────────────────── */}
      <SectionCard
        title="External connections"
        hint="Services authorised to call this pod's API"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setAddOpen(true)}
          >
            Add connection
          </Button>
        }
      >
        {keysQuery.isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : keysQuery.isError ? (
          <ResourceRowError
            message="Couldn't load connections."
            onRetry={() => void keysQuery.refetch()}
          />
        ) : inboundKeys.length === 0 ? (
          <ResourceRowEmpty message="No external connections yet." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
            {inboundKeys.map((k) => (
              <ConnectionRow
                key={k.id}
                apiKey={k}
                podUrl={POD_URL}
                onRevoke={() => setRevokeTarget(k)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Add connection modal */}
      {addOpen && (
        <AddConnectionModal
          workspaceId={workspaceId}
          onClose={() => {
            setAddOpen(false);
            void utils.apiKeys.adminListAll.invalidate({ workspaceId });
          }}
        />
      )}

      {/* Revoke modal */}
      {revokeTarget && (
        <RevokeModal
          apiKey={revokeTarget}
          isPending={revokeMutation.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={async () => {
            await revokeMutation.mutateAsync({
              keyId: revokeTarget.id,
              reason: "Revoked by admin",
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Connection row ───────────────────────────────────────────────────────────

function ConnectionRow({
  apiKey,
  podUrl,
  onRevoke,
}: {
  apiKey: ApiKey;
  podUrl: string;
  onRevoke: () => void;
}) {
  const webhookUrl = `${podUrl}/api/webhooks/inbound/${apiKey.id}`;

  return (
    <div className="flex flex-col gap-2 py-3 px-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound
            className="h-4 w-4 shrink-0 text-foreground/40"
            aria-hidden
          />
          <div className="min-w-0 flex flex-col">
            <span className="text-[13px] font-medium text-foreground truncate">
              {apiKey.keyName}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/55">
            API Key
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">
            <Check className="h-2.5 w-2.5" />
            Active
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            aria-label="Revoke connection"
            className="text-foreground/40 hover:text-danger"
            onPress={onRevoke}
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <code className="font-mono text-[10.5px] bg-foreground/[0.02] border border-foreground/[0.06] rounded-md px-2 py-1 text-foreground/55 truncate block">
        POST {webhookUrl}
      </code>
    </div>
  );
}

// ─── Add connection modal (3-step flow) ───────────────────────────────────────

function AddConnectionModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  const [step, setStep] = useState<Step>("method");
  const [method, setMethod] = useState<AuthMethod>("api-key");
  const [name, setName] = useState("");
  const [jwksUrl, setJwksUrl] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [success, setSuccess] = useState<SuccessPayload | null>(null);

  const createMutation = trpc.apiKeys.create.useMutation({
    onError: (err) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
  });

  const registerIssuerMutation = trpc.trustedIssuers.adminRegister.useMutation({
    onError: (err) =>
      addToast({
        title: "Register failed",
        description: err.message,
        color: "danger",
      }),
  });

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  async function handleGenerate() {
    const res = await createMutation.mutateAsync({
      keyName: name.trim(),
      workspaceId,
      scope: scopes,
    });
    if (res && "key" in res && typeof res.key === "string") {
      const keyId = "id" in res && typeof res.id === "string" ? res.id : "new";
      setSuccess({
        kind: "api-key",
        keyId,
        keyName: name.trim(),
        plaintext: res.key,
      });
      setStep("success");
    }
  }

  async function handleRegisterIssuer() {
    await registerIssuerMutation.mutateAsync({
      issuerUrl: jwksUrl.trim(),
      displayName: name.trim(),
      allowedScopes: scopes,
    });
    setSuccess({
      kind: "jwt-issuer",
      name: name.trim(),
      issuerUrl: jwksUrl.trim(),
      allowedScopes: scopes,
    });
    setStep("success");
  }

  const isConfiguring = step === "configure";
  const isSuccess = step === "success";

  const modalTitle =
    step === "method"
      ? "Connect external service"
      : step === "configure" && method === "api-key"
        ? "Connect external service — API Key"
        : step === "configure" && method === "jwt-issuer"
          ? "Connect external service — Trusted Issuer"
          : success?.kind === "api-key"
            ? "Connected — save your credentials"
            : "Issuer registered";

  const isPending =
    createMutation.isPending || registerIssuerMutation.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
      isDismissable={!isSuccess}
      hideCloseButton={isSuccess}
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{
              background:
                method === "jwt-issuer"
                  ? "rgba(52, 211, 153, 0.18)"
                  : "rgba(99, 179, 237, 0.18)",
            }}
          >
            {method === "jwt-issuer" ? (
              <ShieldCheck className="h-3.5 w-3.5 text-foreground/85" />
            ) : (
              <KeyRound className="h-3.5 w-3.5 text-foreground/85" />
            )}
          </span>
          <span className="text-[15px] font-medium">{modalTitle}</span>
        </ModalHeader>

        <ModalBody className="gap-4 px-6 py-4">
          {/* Step 1 — method selection */}
          {step === "method" && (
            <>
              <Input
                label="Service name"
                placeholder="e.g. n8n integration"
                value={name}
                onValueChange={setName}
                size="sm"
                isRequired
              />
              <div className="flex flex-col gap-1.5">
                <p className="text-[12.5px] font-medium text-foreground">
                  How will it authenticate?
                </p>
                <MethodCard
                  selected={method === "api-key"}
                  onSelect={() => setMethod("api-key")}
                  icon={<KeyRound className="h-4 w-4 text-foreground/60" />}
                  title="API Key"
                  description="Synap generates a secret key. Your backend sends it as Authorization: Bearer {key}"
                />
                <MethodCard
                  selected={method === "jwt-issuer"}
                  onSelect={() => setMethod("jwt-issuer")}
                  icon={<ShieldCheck className="h-4 w-4 text-foreground/60" />}
                  title="Trusted JWT Issuer"
                  description="Register your JWKS endpoint. Synap verifies JWTs your backend signs — no shared secret."
                />
              </div>
            </>
          )}

          {/* Step 2a — API Key */}
          {isConfiguring && method === "api-key" && (
            <>
              <p className="text-[12.5px] text-foreground/55">
                A Hub Protocol inbound key will be generated for{" "}
                <span className="font-medium text-foreground">{name}</span>.
                Your backend uses it as a Bearer token.
              </p>
              <ScopeCheckboxes scopes={scopes} onToggle={toggleScope} />
            </>
          )}

          {/* Step 2b — JWT Issuer */}
          {isConfiguring && method === "jwt-issuer" && (
            <>
              <Input
                label="JWKS endpoint URL"
                placeholder="https://myapp.supabase.co/auth/v1/.well-known/jwks.json"
                description="The public JSON Web Key Set endpoint for your backend"
                value={jwksUrl}
                onValueChange={setJwksUrl}
                size="sm"
                isRequired
              />
              <ScopeCheckboxes scopes={scopes} onToggle={toggleScope} />
            </>
          )}

          {/* Step 3 — Success: API Key */}
          {isSuccess && success?.kind === "api-key" && (
            <ApiKeySuccessBody success={success} podUrl={POD_URL} />
          )}

          {/* Step 3 — Success: JWT Issuer */}
          {isSuccess && success?.kind === "jwt-issuer" && (
            <IssuerSuccessBody success={success} podUrl={POD_URL} />
          )}
        </ModalBody>

        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          {step === "method" && (
            <>
              <Button variant="flat" radius="md" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button
                color="primary"
                radius="md"
                size="sm"
                isDisabled={!name.trim()}
                onPress={() => setStep("configure")}
              >
                Next →
              </Button>
            </>
          )}
          {isConfiguring && method === "api-key" && (
            <>
              <Button
                variant="flat"
                radius="md"
                size="sm"
                isDisabled={isPending}
                onPress={() => setStep("method")}
              >
                ← Back
              </Button>
              <Button
                color="primary"
                radius="md"
                size="sm"
                isDisabled={scopes.length === 0 || isPending}
                isLoading={isPending}
                onPress={() => void handleGenerate()}
              >
                Generate key
              </Button>
            </>
          )}
          {isConfiguring && method === "jwt-issuer" && (
            <>
              <Button
                variant="flat"
                radius="md"
                size="sm"
                isDisabled={isPending}
                onPress={() => setStep("method")}
              >
                ← Back
              </Button>
              <Button
                color="primary"
                radius="md"
                size="sm"
                isDisabled={!jwksUrl.trim() || scopes.length === 0 || isPending}
                isLoading={isPending}
                onPress={() => void handleRegisterIssuer()}
              >
                Register issuer
              </Button>
            </>
          )}
          {isSuccess && (
            <Button color="primary" size="sm" radius="md" onPress={onClose}>
              Done
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Method selection card ────────────────────────────────────────────────────

function MethodCard({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "flex items-start gap-3 rounded-lg p-3 text-left transition-all",
        selected
          ? "ring-1 ring-primary bg-primary/[0.04]"
          : "ring-1 ring-foreground/[0.08] hover:ring-foreground/20",
      ].join(" ")}
    >
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="text-[11.5px] text-foreground/55">{description}</span>
      </div>
    </button>
  );
}

// ─── Scope checkboxes ─────────────────────────────────────────────────────────

function ScopeCheckboxes({
  scopes,
  onToggle,
}: {
  scopes: string[];
  onToggle: (s: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12.5px] font-medium text-foreground">
        Allowed scopes
        <span className="ml-1 text-[11px] font-normal text-foreground/45">
          (optional)
        </span>
      </p>
      <div className="rounded-lg ring-1 ring-inset ring-foreground/10">
        {CONNECTION_SCOPES.map((s) => (
          <label
            key={s.value}
            className="flex cursor-pointer items-start gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
          >
            <Checkbox
              size="sm"
              isSelected={scopes.includes(s.value)}
              onValueChange={() => onToggle(s.value)}
            />
            <span className="flex flex-col">
              <span className="text-[12.5px] font-medium text-foreground">
                {s.label}
              </span>
              <span className="text-[11px] text-foreground/55">
                {s.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Success bodies ───────────────────────────────────────────────────────────

function ApiKeySuccessBody({
  success,
  podUrl,
}: {
  success: SuccessApiKey;
  podUrl: string;
}) {
  const webhookUrl = `${podUrl}/api/webhooks/inbound/${success.keyId}`;
  const curlSnippet = `curl -X POST ${webhookUrl} \\
  -H "Authorization: Bearer ${success.plaintext}" \\
  -H "Content-Type: application/json" \\
  -d '{"event": "your.event", "data": {}}'`;

  return (
    <>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
        <ShieldAlert
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
          aria-hidden
        />
        <p className="text-[11.5px] text-foreground/70">
          This key will only be shown once. Copy it now before closing.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          Secret key
        </p>
        <Snippet
          symbol=""
          size="sm"
          className="overflow-hidden font-mono"
          classNames={{ base: "bg-foreground/[0.05]" }}
        >
          {success.plaintext}
        </Snippet>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          Webhook / API endpoint
        </p>
        <Snippet
          symbol=""
          size="sm"
          className="overflow-hidden font-mono"
          classNames={{ base: "bg-foreground/[0.05]" }}
        >
          {webhookUrl}
        </Snippet>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          How to use
        </p>
        <pre className="overflow-x-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.03] px-3 py-2.5 font-mono text-[10.5px] text-foreground/70 whitespace-pre-wrap break-all">
          {curlSnippet}
        </pre>
      </div>
    </>
  );
}

function IssuerSuccessBody({
  success,
  podUrl,
}: {
  success: SuccessIssuer;
  podUrl: string;
}) {
  return (
    <>
      <div className="flex items-start gap-2 rounded-md border border-success/20 bg-success/[0.06] px-3 py-2.5">
        <Check
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
          aria-hidden
        />
        <p className="text-[11.5px] text-foreground/70">
          <span className="font-medium text-foreground">{success.name}</span> (
          {success.issuerUrl}) is now trusted on this pod.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          Allowed scopes
        </p>
        <div className="flex flex-wrap gap-1">
          {success.allowedScopes.map((s) => (
            <Chip
              key={s}
              size="sm"
              radius="sm"
              variant="flat"
              className="bg-foreground/[0.06] text-[11px] text-foreground/65"
            >
              {s}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          Your backend can now call
        </p>
        <Snippet
          symbol=""
          size="sm"
          className="overflow-hidden font-mono"
          classNames={{ base: "bg-foreground/[0.05]" }}
        >
          {`${podUrl}/api/hub/*`}
        </Snippet>
        <p className="text-[11.5px] text-foreground/55">
          Use a JWT signed by your private key in the{" "}
          <code className="font-mono">Authorization: Bearer</code> header.
        </p>
      </div>
    </>
  );
}

// ─── Revoke modal ─────────────────────────────────────────────────────────────

function RevokeModal({
  apiKey,
  isPending,
  onClose,
  onConfirm,
}: {
  apiKey: ApiKey;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="sm"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Ban className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">
            Revoke {apiKey.keyName}?
          </span>
        </ModalHeader>
        <ModalBody className="px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            This connection will stop accepting requests immediately. Your
            backend will need a new connection to call this pod.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={() => void onConfirm()}
          >
            Revoke
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
