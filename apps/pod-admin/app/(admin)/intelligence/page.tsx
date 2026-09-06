"use client";

/**
 * Intelligence tab — pod-wide AI infrastructure.
 *
 * Per-workspace AI defaults live in Studio's `AgentsTab`. This tab is the
 * pod operator's view: which providers are configured, which IS instances
 * are healthy, what the pod-wide defaults are, and a thin OpenClaw
 * status readout.
 *
 * This is the only tab that uses the emerald accent. Per the brief: use
 * it sparingly — header icons, key indicators, primary CTAs only.
 *
 * Sections:
 *   0. AI provider registry
 *   1. Provider health  — per-provider configured/health (responsive grid)
 *   2. Default models   — pod-wide model defaults
 *   3. IS instances     — `intelligenceRegistry.list`
 *   4. Proactive AI     — pod-wide proactive defaults
 *   5. Failed AI turns  — thin list from runs.list(flowType=chat, status=failed)
 *   6. OpenClaw summary — read-only status; nothing here manages it
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
  Select,
  SelectItem,
  Spinner,
  Switch,
  Tooltip,
} from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Cpu,
  Eye,
  Gauge,
  Key,
  Layers,
  MessagesSquare,
  Pencil,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { openIn } from "../../../lib/open-in";
import { DesktopFallbackLink } from "../../../lib/exit-link";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { HandoffCard } from "../components/handoff-card";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import type { StatusKind } from "../components/status-pill";
import { StatusPill } from "../components/status-pill";

// ─── Page ─────────────────────────────────────────────────────────────

export default function IntelligencePage() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-success/10 ring-1 ring-inset ring-success/25"
        >
          <Sparkles
            className="h-4 w-4 text-success"
            strokeWidth={2}
            aria-hidden
          />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            Intelligence
          </h1>
          <p className="text-[13px] text-foreground/55">
            Pod-wide AI providers and services. Per-workspace overrides live in
            Studio.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-6">
        <AIProvidersSection />
        <ProviderHealthSection />
        <DefaultModelsSection />
        <IntelligenceServicesSection />
        <ProactiveDefaultsSection />
        <FailedAiTurnsSection />
        <OpenClawSummarySection />
      </div>
    </div>
  );
}

// ─── 0. AI Provider Registry (ai_providers table) ─────────────────────

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

function AIProvidersSection() {
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
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({ title: "Failed", description: e.message, color: "danger" });
    },
  });
  const disableMutation = trpc.aiProviders.disable.useMutation({
    onSuccess: () => void utils.aiProviders.list.invalidate(),
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({ title: "Failed", description: e.message, color: "danger" });
    },
  });
  const removeMutation = trpc.aiProviders.remove.useMutation({
    onSuccess: () => {
      void utils.aiProviders.list.invalidate();
      setDeleteTarget(null);
      addToast({ title: "Provider removed", color: "default" });
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({
        title: "Remove failed",
        description: e.message,
        color: "danger",
      });
    },
  });
  const probeMutation = trpc.aiProviders.probe.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        addToast({
          title: `Probe OK (${r.latencyMs}ms)`,
          description: `${r.models.length} models available`,
          color: "default",
        });
      } else {
        addToast({
          title: "Probe failed",
          description: r.error ?? "unknown",
          color: "warning",
        });
      }
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({
        title: "Probe error",
        description: e.message,
        color: "danger",
      });
    },
  });
  const syncMutation = trpc.aiProviders.sync.useMutation({
    onSuccess: (r) =>
      addToast({
        title: `Synced ${r.count} providers to IS`,
        color: "default",
      }),
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({
        title: "Sync failed",
        description: e.message,
        color: "danger",
      });
    },
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
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
                      aria-label={p.enabled ? "Enabled" : "Disabled"}
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
                      aria-label="Test"
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
                      aria-label="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      isIconOnly
                      onPress={() => setDeleteTarget(p)}
                      aria-label="Delete"
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
        description: "IS sync triggered.",
        color: "default",
      });
      onSaved();
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/intelligence")) return;
      addToast({
        title: "Save failed",
        description: e.message,
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

// ─── 1. Provider health ───────────────────────────────────────────────

/**
 * Today the only signal we have for "providers" is the same
 * intelligenceServices table — these ARE the registered AI providers (an
 * IS instance often wraps a single provider; the `default` row is the
 * built-in Synap provider).
 *
 * For per-provider config (OpenRouter API key, Anthropic key, …) we have
 * `intelligenceRegistry.getServiceConfig` — but it requires a serviceId
 * and is scope-gated. So we render a card per active service, and stub
 * "Configure" with a TODO.
 */

interface ProviderCardData {
  id: string;
  serviceId: string;
  name: string;
  status: StatusKind;
  statusLabel: string;
  pricing?: string | null;
  capabilities: string[];
  isBuiltIn: boolean;
}

function ProviderHealthSection() {
  const query = trpc.capabilities.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  const checkHealthMutation = trpc.capabilities.checkHealth.useMutation({
    onSuccess: () => {
      void query.refetch();
    },
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const cards: ProviderCardData[] = (
    query.data?.intelligenceServices ?? []
  ).map((s) => {
    const isBuiltIn = s.serviceId === "default";
    let status: StatusKind = "unknown";
    let statusLabel = "Unknown";
    // NOTE: `isBuiltIn` no longer short-circuits to "healthy". Painting the
    // default service green because it is "Configured" reported the EASY fact
    // (a row exists) instead of the TRUE one (did a ping succeed) — and the
    // health worker skipped default services entirely, so that green was never
    // backed by evidence. The worker now pings them; this renders its verdict.
    if (s.lastHealthStatus === "healthy") {
      status = "healthy";
      statusLabel = "Healthy";
    } else if (s.lastHealthStatus === "degraded") {
      status = "stale";
      statusLabel = "Degraded";
    } else if (s.lastHealthStatus === "unhealthy") {
      status = "down";
      statusLabel = "Unhealthy";
    } else if (s.lastHealthStatus === "unmonitored") {
      // The worker looked and found nothing to ping (no webhookUrl). Distinct
      // from "never looked" — an unmonitored service is a REPORTED state.
      status = "stale";
      statusLabel = "Not monitored";
    } else {
      status = "unknown";
      statusLabel = "Not pinged";
    }
    return {
      id: s.id,
      serviceId: s.serviceId,
      name: s.name,
      status,
      statusLabel,
      pricing: s.pricing,
      capabilities: (s.capabilities ?? []) as string[],
      isBuiltIn,
    };
  });

  return (
    <SectionCard
      title="Provider health"
      hint="Configured AI providers with cached health"
      actions={
        cards.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {cards.length} providers
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 p-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]"
            >
              <div className="h-3 w-1/2 rounded bg-foreground/10 shimmer-pulse" />
              <div className="h-2.5 w-3/4 rounded bg-foreground/[0.07] shimmer-pulse" />
              <div className="h-5 w-20 rounded bg-foreground/[0.07] shimmer-pulse" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorBanner
          message={query.error?.message ?? "Couldn't load providers."}
        />
      ) : cards.length === 0 ? (
        <ResourceRowEmpty message="No AI providers registered." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <ProviderCard
              key={c.id}
              card={c}
              onTest={() =>
                !c.isBuiltIn &&
                checkHealthMutation.mutate({ serviceId: c.serviceId })
              }
              isTesting={
                checkHealthMutation.isPending &&
                checkHealthMutation.variables?.serviceId === c.serviceId
              }
            />
          ))}
        </div>
      )}

      {/* Rendered unconditionally: "where configuration lives" is true whether
          or not the list loaded, and a reader who hits an error still needs the
          way out. */}
      <div className="mt-3">
        <HandoffCard
          icon={Settings}
          title="Service configuration lives in the desktop app"
          body="Credentials and endpoints for a provider are edited in the AI provider registry above. Which models an agent may reach, and the governance around them, are set per workspace in the desktop app's AI settings."
          exit={openIn({ kind: "settings", section: "ai-governance" })}
          cta="Open AI settings"
        />
      </div>
    </SectionCard>
  );
}

function ProviderCard({
  card,
  onTest,
  isTesting,
}: {
  card: ProviderCardData;
  onTest: () => void;
  isTesting: boolean;
}) {
  return (
    <div
      className={[
        "flex flex-col gap-2.5 p-3 rounded-medium",
        "ring-1 ring-inset ring-foreground/10",
        "bg-foreground/[0.02]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-success/10"
          >
            <Cpu
              className="h-3.5 w-3.5 text-success"
              strokeWidth={2}
              aria-hidden
            />
          </span>
          <div className="flex flex-col min-w-0">
            <span className="truncate text-[13px] font-medium text-foreground">
              {card.name}
            </span>
            <span className="truncate text-[11px] text-foreground/45 tabular">
              {card.serviceId}
            </span>
          </div>
        </div>
        <StatusPill kind={card.status} label={card.statusLabel} />
      </div>

      {card.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.capabilities.slice(0, 4).map((cap) => (
            <span
              key={cap}
              className="rounded-sm bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] text-foreground/55"
            >
              {cap}
            </span>
          ))}
          {card.capabilities.length > 4 && (
            <span className="text-[10.5px] text-foreground/45">
              +{card.capabilities.length - 4}
            </span>
          )}
        </div>
      )}

      {/* No "Configure" here. pod-admin is the front desk: it reports a
          service's health, it does not own the service's configuration. The
          section-level handoff below says where that lives — a disabled button
          taught "broken", which was never true. */}
      <div className="mt-auto flex items-center gap-1">
        {!card.isBuiltIn && (
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            isDisabled={isTesting}
            startContent={
              isTesting ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Activity className="h-3 w-3" />
              )
            }
            onPress={onTest}
          >
            Test
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── 2. Default models ────────────────────────────────────────────────

/**
 * The pod-wide model defaults are now exposed by `intelligence.getPodDefaults`
 * / `intelligence.setPodDefaults`. Each slot accepts `null` to mean
 * "Inherit from default IS"; a string is the model id (free-form, since
 * the registry of valid models is provider-dependent and not enumerated
 * by the backend yet).
 */

interface ModelSlot {
  key: "chat" | "reasoning" | "embedding" | "vision";
  label: string;
  icon: LucideIcon;
  hint: string;
}

const MODEL_SLOTS: ModelSlot[] = [
  {
    key: "chat",
    label: "Chat model",
    icon: Sparkles,
    hint: "Used for general chat across new workspaces",
  },
  {
    key: "reasoning",
    label: "Reasoning model",
    icon: Layers,
    hint: "For deeper reasoning and orchestration",
  },
  {
    key: "embedding",
    label: "Embedding model",
    icon: Radio,
    hint: "Vector embeddings for memory + search",
  },
  {
    key: "vision",
    label: "Vision model",
    icon: Eye,
    hint: "Image understanding for capture + chat",
  },
];

type DefaultsState = {
  chatModelId: string | null;
  reasoningModelId: string | null;
  embeddingModelId: string | null;
  visionModelId: string | null;
};

const SLOT_TO_FIELD: Record<ModelSlot["key"], keyof DefaultsState> = {
  chat: "chatModelId",
  reasoning: "reasoningModelId",
  embedding: "embeddingModelId",
  vision: "visionModelId",
};

function DefaultModelsSection() {
  const [editing, setEditing] = useState(false);
  const query = trpc.intelligence.getPodDefaults.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const defaults = query.data?.defaults;

  return (
    <SectionCard
      title="Default models"
      hint="Pod-wide defaults — workspaces inherit unless overridden in Studio"
      actions={
        <Button
          size="sm"
          variant="flat"
          radius="md"
          color="primary"
          startContent={<Settings className="h-3 w-3" />}
          onPress={() => setEditing(true)}
          isDisabled={query.isLoading || query.isError || isAuthRedirecting}
        >
          Edit defaults
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {MODEL_SLOTS.map((slot) => {
          const field = SLOT_TO_FIELD[slot.key];
          const value = defaults ? defaults[field] : null;
          return (
            <div
              key={slot.key}
              className="flex items-start gap-2.5 p-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]"
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-success/10"
              >
                <slot.icon
                  className="h-3.5 w-3.5 text-success"
                  strokeWidth={2}
                  aria-hidden
                />
              </span>
              <div className="flex flex-col min-w-0">
                <span className="text-[12.5px] font-medium text-foreground">
                  {slot.label}
                </span>
                <span className="text-[11px] text-foreground/55 truncate">
                  {slot.hint}
                </span>
                <span className="mt-1 text-[11.5px] text-foreground/45 tabular truncate">
                  {query.isLoading || isAuthRedirecting
                    ? "Loading…"
                    : value
                      ? value
                      : "Inherit from default IS"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {editing && defaults ? (
        <DefaultModelsModal
          initial={defaults}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SectionCard>
  );
}

function DefaultModelsModal({
  initial,
  onClose,
}: {
  initial: DefaultsState;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<DefaultsState>(initial);

  const setMutation = trpc.intelligence.setPodDefaults.useMutation({
    onSuccess: () => {
      void utils.intelligence.getPodDefaults.invalidate();
      addToast({
        title: "Defaults updated",
        description: "Pod-wide model defaults saved.",
        color: "default",
      });
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/intelligence")) return;
      addToast({
        title: "Save failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  function setField(field: keyof DefaultsState, value: string) {
    setDraft((d) => ({
      ...d,
      [field]: value.trim() === "" ? null : value,
    }));
  }

  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()} size="md">
      <ModalContent className="bg-background">
        <ModalHeader className="flex flex-col gap-0.5 px-5 pt-5 pb-2">
          <span className="text-[14px] font-medium text-foreground">
            Edit pod-wide defaults
          </span>
          <span className="text-[11.5px] text-foreground/55">
            Leave a slot empty to inherit from the default IS.
          </span>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-3 px-5 py-3">
          {MODEL_SLOTS.map((slot) => {
            const field = SLOT_TO_FIELD[slot.key];
            return (
              <Input
                key={slot.key}
                label={slot.label}
                placeholder="Inherit from default IS"
                size="sm"
                variant="bordered"
                radius="md"
                value={draft[field] ?? ""}
                onValueChange={(v) => setField(field, v)}
                isDisabled={setMutation.isPending}
                description={slot.hint}
              />
            );
          })}
        </ModalBody>
        <ModalFooter className="flex justify-end gap-2 px-5 pb-5 pt-2">
          <Button
            size="sm"
            variant="light"
            radius="md"
            onPress={onClose}
            isDisabled={setMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            color="primary"
            radius="md"
            isLoading={setMutation.isPending}
            onPress={() => setMutation.mutate(draft)}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── 3. Intelligence services ────────────────────────────────────────

interface ISInstanceRow {
  id: string;
  serviceId: string;
  name: string;
  description?: string | null;
  status: string;
  enabled: boolean;
}

function IntelligenceServicesSection() {
  const query = trpc.intelligenceRegistry.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const rows = (query.data ?? []) as ISInstanceRow[];

  return (
    <SectionCard
      title="Intelligence service instances"
      hint="Registered IS instances that respond to /health"
      actions={
        rows.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {rows.length} instances
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ErrorBanner
          message={query.error?.message ?? "Couldn't load IS registry."}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="No IS instances registered." />
      ) : (
        <div className="-mx-2">
          {rows.map((row) => (
            <ResourceRow
              key={row.id}
              Icon={Plug}
              primary={row.name}
              secondary={[row.serviceId, row.description]
                .filter(Boolean)
                .join(" · ")}
              status={isStatusToPill(row.status, row.enabled)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function isStatusToPill(
  status: string,
  enabled: boolean
): { kind: StatusKind; label: string } {
  if (!enabled) return { kind: "unknown", label: "Disabled" };
  switch (status) {
    case "active":
      return { kind: "healthy", label: "Active" };
    case "suspended":
      return { kind: "stale", label: "Suspended" };
    case "inactive":
      return { kind: "down", label: "Inactive" };
    default:
      return { kind: "unknown", label: status };
  }
}

// ─── 4. Proactive AI defaults ────────────────────────────────────────

/**
 * Pod-wide defaults applied to new workspaces (overridable in Studio).
 * Backed by `trpc.proactive.getPodDefaults` / `proactive.setPodDefaults`.
 * Edits are debounced via an explicit Save button so toggles don't fire
 * a mutation on every interaction.
 */

type ProactiveDraft = {
  enabled: boolean;
  nudgeDensity: "low" | "medium" | "high";
  schedules: {
    morningBriefing: boolean;
    weeklyDigest: boolean;
    healthCheck: boolean;
  };
};

function ProactiveDefaultsSection() {
  const utils = trpc.useUtils();
  const query = trpc.proactive.getPodDefaults.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const [draft, setDraft] = useState<ProactiveDraft | null>(null);

  // Seed local draft from server data on first load — afterwards local
  // edits stay local until Save / Reset.
  if (draft === null && query.data) {
    setDraft(query.data.defaults);
  }

  const setMutation = trpc.proactive.setPodDefaults.useMutation({
    onSuccess: () => {
      void utils.proactive.getPodDefaults.invalidate();
      addToast({
        title: "Defaults saved",
        description: "Pod-wide proactive defaults updated.",
        color: "default",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/intelligence")) return;
      addToast({
        title: "Save failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const dirty = useMemo(() => {
    if (!draft || !query.data) return false;
    const a = draft;
    const b = query.data.defaults;
    return (
      a.enabled !== b.enabled ||
      a.nudgeDensity !== b.nudgeDensity ||
      a.schedules.morningBriefing !== b.schedules.morningBriefing ||
      a.schedules.weeklyDigest !== b.schedules.weeklyDigest ||
      a.schedules.healthCheck !== b.schedules.healthCheck
    );
  }, [draft, query.data]);

  function updateDraft(patch: Partial<ProactiveDraft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  function updateSchedule(key: keyof ProactiveDraft["schedules"], v: boolean) {
    setDraft((d) =>
      d ? { ...d, schedules: { ...d.schedules, [key]: v } } : d
    );
  }

  return (
    <SectionCard
      title="Proactive AI defaults"
      hint="Apply to new workspaces — overridable in Studio"
      actions={
        dirty && draft ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isDisabled={setMutation.isPending}
              onPress={() => query.data && setDraft(query.data.defaults)}
            >
              Reset
            </Button>
            <Button
              size="sm"
              color="primary"
              radius="md"
              isLoading={setMutation.isPending}
              onPress={() => setMutation.mutate(draft)}
            >
              Save
            </Button>
          </div>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting || !draft ? (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-foreground/55">
          <Spinner size="sm" /> Loading proactive defaults…
        </div>
      ) : query.isError ? (
        <ErrorBanner message="Couldn't load pod-wide proactive defaults." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Proactive AI enabled by default
              </span>
              <span className="text-[11px] text-foreground/55">
                Whether new workspaces start with proactive nudges on
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.enabled}
              onValueChange={(v) => updateDraft({ enabled: v })}
              isDisabled={setMutation.isPending}
              aria-label="Proactive AI enabled by default"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Default nudge density
              </span>
              <span className="text-[11px] text-foreground/55">
                How chatty proactive AI is by default
              </span>
            </div>
            <Select
              size="sm"
              radius="md"
              variant="bordered"
              className="max-w-[200px]"
              selectedKeys={[draft.nudgeDensity]}
              onSelectionChange={(keys) => {
                const k = Array.from(keys as Set<string>)[0];
                if (k === "low" || k === "medium" || k === "high") {
                  updateDraft({ nudgeDensity: k });
                }
              }}
              isDisabled={setMutation.isPending}
              aria-label="Default nudge density"
            >
              <SelectItem key="low">low</SelectItem>
              <SelectItem key="medium">medium</SelectItem>
              <SelectItem key="high">high</SelectItem>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Morning briefing
              </span>
              <span className="text-[11px] text-foreground/55">
                Cron-driven daily summary in personal channel
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.morningBriefing}
              onValueChange={(v) => updateSchedule("morningBriefing", v)}
              isDisabled={setMutation.isPending}
              aria-label="Morning briefing enabled"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Weekly digest
              </span>
              <span className="text-[11px] text-foreground/55">
                Sunday roll-up of the week's signals
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.weeklyDigest}
              onValueChange={(v) => updateSchedule("weeklyDigest", v)}
              isDisabled={setMutation.isPending}
              aria-label="Weekly digest enabled"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Health check
              </span>
              <span className="text-[11px] text-foreground/55">
                Daily AI sanity sweep across the workspace
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.healthCheck}
              onValueChange={(v) => updateSchedule("healthCheck", v)}
              isDisabled={setMutation.isPending}
              aria-label="Health check enabled"
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ─── 5. Failed AI turns (chat_turns ledger via unified runs) ──────────

/**
 * Thin operator surface for failed Companion / Discord / external agent turns.
 * Reuses `runs.list({ flowType: "chat", status: "failed" })` — same ledger as
 * browser Runs (Failed filter). No redesign: SectionCard + ResourceRow only.
 *
 * Each row exits to its CHANNEL, not to the run. A run's address is
 * `{flowType, runId}` — `object-nav.ts`'s `run` arm reads `flowType` off the
 * link's params and defaults to `automation` when it is absent, so a bare
 * `synap://open/run/<id>` would resolve to a descriptor that queries the wrong
 * ledger and lands on an empty surface. `openIn` emits no params, so the run
 * link is not one we can honestly emit from here. The channel is: the failed
 * turn happened in a conversation, and that conversation is where an operator
 * reads what went wrong.
 */
function FailedAiTurnsSection() {
  const query = trpc.runs.list.useQuery(
    { flowType: "chat", status: "failed", limit: 15 },
    { staleTime: 15_000, refetchOnWindowFocus: true }
  );

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const runs = query.data?.runs ?? [];

  return (
    <SectionCard
      title="Failed AI turns"
      hint="Recent failed chat turns (Companion, Discord, external agents)"
      actions={
        runs.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {runs.length}
            {runs.length >= 15 ? "+" : ""} shown
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ErrorBanner
          message={query.error?.message ?? "Couldn't load failed AI turns."}
        />
      ) : runs.length === 0 ? (
        <ResourceRowEmpty message="No failed AI turns." />
      ) : (
        <div className="-mx-2">
          {runs.map((run) => {
            const when = formatRelativeTime(run.startedAt);
            // Absent on a turn whose channel was since deleted — no channel,
            // no exit, rather than a link to nothing.
            const exit = run.channelId
              ? openIn({
                  kind: "object",
                  objectKind: "channel",
                  id: run.channelId,
                })
              : null;
            const err =
              typeof run.error === "string" && run.error.trim()
                ? run.error.trim()
                : "Failed";
            // listChatRuns hardcodes flowName "Chat" — surface short turn id so
            // rows are distinguishable / copyable for dogfood correlation.
            const turnShort =
              typeof run.id === "string" && run.id.length >= 8
                ? run.id.slice(0, 8)
                : run.id;
            const secondary = [when, turnShort, err]
              .filter(Boolean)
              .join(" · ");
            return (
              <ResourceRow
                key={run.id}
                Icon={MessagesSquare}
                primary={run.flowName || "Chat"}
                secondary={secondary}
                status={{ kind: "down", label: "Failed" }}
                actions={
                  exit ? (
                    <Button
                      as="a"
                      href={exit.href}
                      size="sm"
                      variant="light"
                      radius="md"
                      startContent={<Eye className="h-3 w-3" />}
                      className="text-foreground/55"
                    >
                      Open channel
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}

      {/* The per-row exits are all `synap://` and all share one fallback, so
          it is spelled once here rather than fifteen times inside the list. A
          desktop link that does not resolve fails SILENTLY — without this the
          reader is left staring at a button that did nothing. */}
      {runs.length > 0 && (
        <p className="mt-3 px-3 text-[11.5px] text-foreground/50">
          Conversations open in the desktop app. <DesktopFallbackLink />
        </p>
      )}
    </SectionCard>
  );
}

function formatRelativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

// ─── 6. OpenClaw summary ─────────────────────────────────────────────

function OpenClawSummarySection() {
  const query = trpc.intelligenceRegistry.getOpenClawOverview.useQuery(
    undefined,
    { staleTime: 60_000, retry: false }
  );

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/intelligence");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const oc = query.data?.openclaw;

  let status: StatusKind = "unknown";
  let statusLabel = "Not provisioned";
  if (oc?.health.status === "healthy") {
    status = "healthy";
    statusLabel = "Healthy";
  } else if (oc?.health.status === "not_responded") {
    status = "stale";
    statusLabel = "No recent traffic";
  } else if (oc?.provisioned === false) {
    status = "unknown";
    statusLabel = "Not provisioned";
  } else if (oc?.health.status === "not_configured") {
    status = "unknown";
    statusLabel = "Not configured";
  }

  return (
    <SectionCard
      title="OpenClaw"
      hint="Pod-wide agent runtime — configured outside Pod Admin"
      actions={<StatusPill kind={status} label={statusLabel} />}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success/10"
          >
            <Bot className="h-4 w-4 text-success" strokeWidth={2} aria-hidden />
          </span>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[14px] font-medium text-foreground">
              {query.isLoading || isAuthRedirecting
                ? "Loading…"
                : oc?.provisioned
                  ? `1 agent provisioned · ${oc.activeHubKeys} active key${
                      oc.activeHubKeys === 1 ? "" : "s"
                    }`
                  : "OpenClaw is not provisioned on this pod"}
            </span>
            <span className="text-[11.5px] text-foreground/55">
              {query.data?.lifecycleDomains?.runtime
                ? `Runtime managed by ${query.data.lifecycleDomains.runtime}`
                : "Skills and agents are configured outside Pod Admin"}
            </span>
          </div>
        </div>
        {/* This was a `href="/openclaw"` button. pod-admin serves no such
            route and there is no rewrite, so it was a hard 404 — and no
            verified OpenClaw URL exists to retarget it at. Rather than invent
            a destination, the card now simply reports what it knows. */}
      </div>
    </SectionCard>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-medium ring-1 ring-inset ring-status-down/30 bg-status-down/[0.06] px-3 py-2.5">
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0 text-status-down"
        strokeWidth={2}
        aria-hidden
      />
      <span className="text-[12.5px] font-medium text-status-down">
        {message}
      </span>
    </div>
  );
}

// Suppress unused-import warnings for icons referenced by lookup only.
void Gauge;
