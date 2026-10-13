"use client";

/**
 * The pod's AI provider registry (`ai_providers`): add, edit, enable, remove.
 * Part of `/intelligence` (`page.tsx`).
 */

import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  Tooltip,
} from "@heroui/react";
import {
  Activity,
  Cpu,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { ErrorBanner } from "./error-banner";

type ProviderRow = {
  id: string;
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  hasApiKey: boolean;
  enabled: boolean;
  priority: number;
  tags: string[];
  models: Array<{ id: string; tier?: string }>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type ProviderFormDraft = {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  apiKey: string;
  priority: string;
  enabled: boolean;
};

const EMPTY_DRAFT: ProviderFormDraft = {
  providerId: "",
  name: "",
  baseUrl: "",
  apiKeyEnvVar: "PROVIDER_API_KEY",
  apiKey: "",
  priority: "10",
  enabled: true,
};

export function AIProvidersSection() {
  const utils = trpc.useUtils();
  const query = trpc.aiProviders.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const [formTarget, setFormTarget] = useState<ProviderRow | null | "new">(
    null
  );
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);

  const enableMutation = trpc.aiProviders.enable.useMutation({
    onSuccess: () => void utils.aiProviders.list.invalidate(),
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't enable the provider",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });
  const disableMutation = trpc.aiProviders.disable.useMutation({
    onSuccess: () => void utils.aiProviders.list.invalidate(),
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't disable the provider",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });
  const removeMutation = trpc.aiProviders.remove.useMutation({
    onSuccess: () => {
      void utils.aiProviders.list.invalidate();
      setDeleteTarget(null);
      addToast({ title: "Provider removed", color: "default" });
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't remove the provider",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });
  const probeMutation = trpc.aiProviders.probe.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        addToast({
          title: `Provider reachable (${r.latencyMs}ms)`,
          description: `${r.models.length} models available`,
          color: "default",
        });
      } else {
        addToast({
          title: "The provider didn't respond correctly",
          description: readableError(r.error),
          color: "warning",
        });
      }
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't test the provider",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });
  const syncMutation = trpc.aiProviders.sync.useMutation({
    onSuccess: (r) =>
      addToast({
        title: `Synced ${r.count} ${r.count === 1 ? "provider" : "providers"} to the intelligence service`,
        color: "default",
      }),
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't sync providers",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const rows = query.data ?? [];

  return (
    <>
      <SectionCard
        title="AI provider registry"
        hint="Pod-level provider configs — synced to IS on every change"
        actions={
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <span className="text-[11px] tabular text-foreground/55">
                {rows.length} provider{rows.length !== 1 ? "s" : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="flat"
              radius="md"
              isDisabled={syncMutation.isPending}
              onPress={() => syncMutation.mutate()}
              startContent={<RefreshCw className="h-3 w-3" />}
            >
              Sync to IS
            </Button>
            <Button
              size="sm"
              color="primary"
              radius="md"
              startContent={<Plus className="h-3 w-3" />}
              onPress={() => setFormTarget("new")}
            >
              Add provider
            </Button>
          </div>
        }
      >
        {query.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={2} />
        ) : query.isError ? (
          <ErrorBanner
            message={query.error?.message ?? "Couldn't load providers."}
          />
        ) : rows.length === 0 ? (
          <ResourceRowEmpty message="No providers registered. Add one to start routing AI requests." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.06]">
            {rows
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  {/* Icon */}
                  <span
                    aria-hidden
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-success/10"
                  >
                    <Cpu className="h-3.5 w-3.5 text-success" strokeWidth={2} />
                  </span>

                  {/* Name + meta */}
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        {p.name}
                      </span>
                      <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] tabular text-foreground/50">
                        #{p.priority}
                      </span>
                      {p.hasApiKey && (
                        <Tooltip content="API key stored">
                          <Key className="h-3 w-3 shrink-0 text-success/70" />
                        </Tooltip>
                      )}
                    </div>
                    <span className="truncate text-[11px] text-foreground/45">
                      {p.providerId} · {p.baseUrl.replace(/^https?:\/\//, "")}
                    </span>
                    {p.models.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {p.models.slice(0, 3).map((m) => (
                          <span
                            key={m.id}
                            className="rounded-sm bg-foreground/[0.05] px-1 py-0.5 text-[10px] text-foreground/40"
                          >
                            {m.id}
                          </span>
                        ))}
                        {p.models.length > 3 && (
                          <span className="text-[10px] text-foreground/35">
                            +{p.models.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Switch
                      size="sm"
                      isSelected={p.enabled}
                      isDisabled={
                        (enableMutation.isPending &&
                          enableMutation.variables?.providerId ===
                            p.providerId) ||
                        (disableMutation.isPending &&
                          disableMutation.variables?.providerId ===
                            p.providerId)
                      }
                      onValueChange={(v) => {
                        if (v)
                          enableMutation.mutate({ providerId: p.providerId });
                        else
                          disableMutation.mutate({ providerId: p.providerId });
                      }}
                      aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                    />
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      isIconOnly
                      isDisabled={
                        probeMutation.isPending &&
                        probeMutation.variables?.providerId === p.providerId
                      }
                      onPress={() =>
                        probeMutation.mutate({ providerId: p.providerId })
                      }
                      aria-label={`Test ${p.name}`}
                    >
                      {probeMutation.isPending &&
                      probeMutation.variables?.providerId === p.providerId ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Activity className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      isIconOnly
                      onPress={() => setFormTarget(p)}
                      aria-label={`Edit ${p.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      isIconOnly
                      onPress={() => setDeleteTarget(p)}
                      aria-label={`Delete ${p.name}`}
                      className="text-danger/70 hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </SectionCard>

      {formTarget !== null && (
        <ProviderFormModal
          initial={formTarget === "new" ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={() => {
            void utils.aiProviders.list.invalidate();
            setFormTarget(null);
          }}
        />
      )}

      {deleteTarget !== null && (
        <Modal
          isOpen
          onOpenChange={(o) => !o && setDeleteTarget(null)}
          size="sm"
        >
          <ModalContent className="bg-background">
            <ModalHeader className="px-5 pt-5 pb-2 text-[14px] font-medium">
              Remove provider?
            </ModalHeader>
            <ModalBody className="px-5 py-2">
              <p className="text-[12.5px] text-foreground/60">
                <strong className="text-foreground">{deleteTarget.name}</strong>{" "}
                will be removed from the registry and the IS will be resynced.
              </p>
            </ModalBody>
            <ModalFooter className="flex justify-end gap-2 px-5 pb-5 pt-2">
              <Button
                size="sm"
                variant="light"
                radius="md"
                onPress={() => setDeleteTarget(null)}
                isDisabled={removeMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                color="danger"
                radius="md"
                isLoading={removeMutation.isPending}
                onPress={() =>
                  removeMutation.mutate({ providerId: deleteTarget.providerId })
                }
              >
                Remove
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </>
  );
}

function ProviderFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ProviderRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ProviderFormDraft>(
    initial
      ? {
          providerId: initial.providerId,
          name: initial.name,
          baseUrl: initial.baseUrl,
          apiKeyEnvVar: initial.apiKeyEnvVar,
          apiKey: "",
          priority: String(initial.priority),
          enabled: initial.enabled,
        }
      : EMPTY_DRAFT
  );

  const upsertMutation = trpc.aiProviders.upsert.useMutation({
    onSuccess: () => {
      addToast({
        title: initial ? "Provider updated" : "Provider added",
        description: "The intelligence service is syncing.",
        color: "default",
      });
      onSaved();
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't save the provider",
        description: readableError(e.message),
        color: "danger",
      });
    },
  });

  function set(field: keyof ProviderFormDraft, value: string | boolean) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function handleSave() {
    const priority = parseInt(draft.priority, 10);
    if (
      !draft.providerId.trim() ||
      !draft.name.trim() ||
      !draft.baseUrl.trim()
    ) {
      addToast({ title: "Required fields missing", color: "warning" });
      return;
    }
    upsertMutation.mutate({
      providerId: draft.providerId.trim(),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKeyEnvVar: draft.apiKeyEnvVar.trim() || "PROVIDER_API_KEY",
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      priority: Number.isNaN(priority) ? 10 : priority,
      enabled: draft.enabled,
    });
  }

  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()} size="md">
      <ModalContent className="bg-background">
        <ModalHeader className="flex flex-col gap-0.5 px-5 pt-5 pb-2">
          <span className="text-[14px] font-medium text-foreground">
            {initial ? "Edit provider" : "Add provider"}
          </span>
          <span className="text-[11.5px] text-foreground/55">
            {initial
              ? "Changes are synced to the IS immediately."
              : "Register a new OpenAI-compatible provider."}
          </span>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-3 px-5 py-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Provider ID"
              placeholder="e.g. openrouter"
              size="sm"
              variant="bordered"
              radius="md"
              value={draft.providerId}
              onValueChange={(v) => set("providerId", v)}
              isDisabled={upsertMutation.isPending || !!initial}
              description={initial ? "Cannot be changed" : "Unique identifier"}
              isRequired
            />
            <Input
              label="Display name"
              placeholder="e.g. OpenRouter"
              size="sm"
              variant="bordered"
              radius="md"
              value={draft.name}
              onValueChange={(v) => set("name", v)}
              isDisabled={upsertMutation.isPending}
              isRequired
            />
          </div>
          <Input
            label="Base URL"
            placeholder="https://openrouter.ai/api/v1"
            size="sm"
            variant="bordered"
            radius="md"
            value={draft.baseUrl}
            onValueChange={(v) => set("baseUrl", v)}
            isDisabled={upsertMutation.isPending}
            isRequired
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="API key env var"
              placeholder="OPENROUTER_API_KEY"
              size="sm"
              variant="bordered"
              radius="md"
              value={draft.apiKeyEnvVar}
              onValueChange={(v) => set("apiKeyEnvVar", v)}
              isDisabled={upsertMutation.isPending}
              description="Env var on the IS"
            />
            <Input
              label="API key"
              placeholder={initial?.hasApiKey ? "Leave blank to keep" : "sk-…"}
              type="password"
              size="sm"
              variant="bordered"
              radius="md"
              value={draft.apiKey}
              onValueChange={(v) => set("apiKey", v)}
              isDisabled={upsertMutation.isPending}
              description="Encrypted at rest"
            />
          </div>
          <div className="flex items-center gap-3">
            <Input
              label="Priority"
              placeholder="10"
              type="number"
              size="sm"
              variant="bordered"
              radius="md"
              className="max-w-[100px]"
              value={draft.priority}
              onValueChange={(v) => set("priority", v)}
              isDisabled={upsertMutation.isPending}
              description="Lower = higher"
            />
            <div className="flex items-center gap-2 pt-1">
              <Switch
                size="sm"
                isSelected={draft.enabled}
                onValueChange={(v) => set("enabled", v)}
                isDisabled={upsertMutation.isPending}
                aria-label="Enabled"
              />
              <span className="text-[12px] text-foreground/60">Enabled</span>
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="flex justify-end gap-2 px-5 pb-5 pt-2">
          <Button
            size="sm"
            variant="light"
            radius="md"
            onPress={onClose}
            isDisabled={upsertMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            color="primary"
            radius="md"
            isLoading={upsertMutation.isPending}
            onPress={handleSave}
          >
            {initial ? "Save changes" : "Add provider"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
