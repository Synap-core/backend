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
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
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
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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
 * The pod-wide model defaults are not currently exposed by a dedicated
 * tRPC procedure — `getEffectiveService` is workspace-scoped and we
 * intentionally don't pin a workspace in pod-admin. We render a stubbed
 * card listing slot names; "Edit defaults" is wired to a placeholder
 * modal that flags the gap to the operator.
 */

interface ModelSlot {
  key: string;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const MODEL_SLOTS: ModelSlot[] = [
  {
    key: "default",
    label: "Default model",
    icon: Sparkles,
    hint: "Used for general chat across new workspaces",
  },
  {
    key: "fallback",
    label: "Fallback model",
    icon: Layers,
    hint: "Pulled when the default is unavailable",
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

function DefaultModelsSection() {
  const [editing, setEditing] = useState(false);

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
        >
          Edit defaults
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {MODEL_SLOTS.map((slot) => (
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
              <span className="mt-1 text-[11.5px] text-foreground/45 tabular">
                {/* TODO(phase-C): resolve from
                    trpc.intelligenceRegistry.getServiceConfig once a
                    pod-wide defaults procedure exists. */}
                Inherits from `default` IS
              </span>
            </div>
          </div>
        ))}
      </div>

      <DefaultModelsModal isOpen={editing} onClose={() => setEditing(false)} />
    </SectionCard>
  );
}

function DefaultModelsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={(o) => !o && onClose()} size="md">
      <ModalContent className="bg-background">
        <ModalHeader className="flex flex-col gap-0.5 px-5 pt-5 pb-2">
          <span className="text-[14px] font-medium text-foreground">
            Edit pod-wide defaults
          </span>
          <span className="text-[11.5px] text-foreground/55">
            These apply to new workspaces unless overridden in Studio.
          </span>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-3 px-5 py-3">
          {MODEL_SLOTS.map((slot) => (
            <Select
              key={slot.key}
              label={slot.label}
              placeholder="Inherit from default IS"
              size="sm"
              variant="bordered"
              radius="md"
              isDisabled
            >
              {/* TODO(phase-C): list models from the registered IS once a
                  pod-wide defaults procedure ships. */}
              <SelectItem key="placeholder">No models loaded</SelectItem>
            </Select>
          ))}
          <div className="rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.04] px-3 py-2.5">
            <p className="text-[11.5px] text-foreground/55">
              A pod-wide model-defaults procedure has not shipped yet. Today
              workspaces resolve defaults via{" "}
              <code className="text-foreground/85 tabular">
                intelligence.getEffectiveService
              </code>
              .
            </p>
          </div>
        </ModalBody>
        <ModalFooter className="flex justify-end gap-2 px-5 pb-5 pt-2">
          <Button size="sm" variant="light" radius="md" onPress={onClose}>
            Cancel
          </Button>
          <Button size="sm" color="primary" radius="md" isDisabled>
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
 * `trpc.proactive.getPrefs/updatePrefs` is workspace-scoped (writes into
 * `workspaces.settings.proactiveAi`). There is no pod-wide proactive
 * defaults procedure today, so this whole section is stubbed with the
 * intended controls — operators will be able to set these once the
 * backend lands the corresponding procedure.
 */

function ProactiveDefaultsSection() {
  return (
    <SectionCard
      title="Proactive AI defaults"
      hint="Apply to new workspaces — overridable in Studio"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium text-foreground">
              Default proactive policy
            </span>
            <span className="text-[11px] text-foreground/55">
              Who can trigger proactive AI in a workspace
            </span>
          </div>
          <Select
            size="sm"
            radius="md"
            variant="bordered"
            placeholder="owner_and_admins"
            className="max-w-[200px]"
            isDisabled
          >
            <SelectItem key="owner_and_admins">owner_and_admins</SelectItem>
            <SelectItem key="admins_only">admins_only</SelectItem>
            <SelectItem key="any_editor">any_editor</SelectItem>
            <SelectItem key="disabled">disabled</SelectItem>
          </Select>
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
            placeholder="balanced"
            className="max-w-[200px]"
            isDisabled
          >
            <SelectItem key="minimal">minimal</SelectItem>
            <SelectItem key="balanced">balanced</SelectItem>
            <SelectItem key="proactive">proactive</SelectItem>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium text-foreground">
              Morning briefing enabled by default
            </span>
            <span className="text-[11px] text-foreground/55">
              Cron-driven daily summary in personal channel
            </span>
          </div>
          <StatusPill kind="unknown" label="Inherit" />
        </div>

        <div className="rounded-medium ring-1 ring-inset ring-status-stale/30 bg-status-stale/[0.06] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Wrench
              className="h-3.5 w-3.5 shrink-0 mt-0.5 text-status-stale"
              strokeWidth={2}
              aria-hidden
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium text-status-stale">
                Pod-wide proactive defaults not wired yet
              </span>
              <p className="text-[11px] text-foreground/55">
                {/* TODO(phase-C): backend exposes only
                    `trpc.proactive.getPrefs/updatePrefs` (workspace-scoped).
                    A pod-wide variant — `proactive.getPodDefaults` /
                    `proactive.setPodDefaults` — is required to make these
                    controls writable. */}
                Current proactive prefs live per-workspace (
                <code className="text-foreground/85 tabular">
                  workspaces.settings.proactiveAi
                </code>
                ). A pod-defaults procedure is needed before these controls can
                save.
              </p>
            </div>
          </div>
        </div>
      </div>
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
