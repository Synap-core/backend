"use client";

/**
 * Intelligence tab — pod-wide AI infrastructure.
 *
 * Per-workspace AI defaults live in Studio's `AgentsTab`. This tab is the
 * pod operator's view: which providers are configured, which IS instances
 * are healthy, what the pod-wide defaults are, and a thin OpenClaw
 * summary that links out.
 *
 * This is the only tab that uses the emerald accent. Per the brief: use
 * it sparingly — header icons, key indicators, primary CTAs only.
 *
 * Sections:
 *   1. Provider health  — per-provider configured/health (responsive grid)
 *   2. Default models   — pod-wide model defaults
 *   3. IS instances     — `intelligenceRegistry.list`
 *   4. Proactive AI     — pod-wide proactive defaults (stub today)
 *   5. OpenClaw summary — thin card with "Manage in OpenClaw" link
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
  Layers,
  Plug,
  Radio,
  RefreshCw,
  Settings,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { trpc } from "../../../lib/trpc";
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
        <ProviderHealthSection />
        <DefaultModelsSection />
        <IntelligenceServicesSection />
        <ProactiveDefaultsSection />
        <OpenClawSummarySection />
      </div>
    </div>
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

  const cards: ProviderCardData[] = (
    query.data?.intelligenceServices ?? []
  ).map((s) => {
    const isBuiltIn = s.serviceId === "default";
    let status: StatusKind = "unknown";
    let statusLabel = "Unknown";
    if (isBuiltIn) {
      status = "healthy";
      statusLabel = "Configured";
    } else if (s.lastHealthStatus === "healthy") {
      status = "healthy";
      statusLabel = "Healthy";
    } else if (s.lastHealthStatus === "degraded") {
      status = "stale";
      statusLabel = "Degraded";
    } else if (s.lastHealthStatus === "unhealthy") {
      status = "down";
      statusLabel = "Unhealthy";
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
      {query.isLoading ? (
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

      <div className="mt-auto flex items-center gap-1">
        <Tooltip content="Pending: intelligenceRegistry.updateServiceConfig">
          <span className="block">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isDisabled
              startContent={<Settings className="h-3 w-3" />}
              className="text-foreground/55"
              // TODO(phase-C): open a modal that calls
              // trpc.intelligenceRegistry.getServiceConfig + .update — gated
              // behind scoped permissions today.
            >
              Configure
            </Button>
          </span>
        </Tooltip>
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
          isDisabled={query.isLoading || query.isError}
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
                  {query.isLoading
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
      {query.isLoading ? (
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
      {query.isLoading || !draft ? (
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

// ─── 5. OpenClaw summary ─────────────────────────────────────────────

function OpenClawSummarySection() {
  const query = trpc.intelligenceRegistry.getOpenClawOverview.useQuery(
    undefined,
    { staleTime: 60_000, retry: false }
  );

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
      hint="Pod-wide agent runtime — manage from Eve"
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
              {query.isLoading
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
                : "Skills + agents managed in Eve"}
            </span>
          </div>
        </div>
        <Button
          as="a"
          href="/openclaw"
          size="sm"
          variant="solid"
          color="primary"
          radius="md"
          startContent={<Zap className="h-3 w-3" />}
        >
          Manage in OpenClaw
        </Button>
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
