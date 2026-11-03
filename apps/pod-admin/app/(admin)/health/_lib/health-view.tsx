"use client";

/**
 * Pod health's body, presentational: every state the page answers (loading,
 * failed with Retry, unreadable, ready) from props only, so a render test
 * pins each one. The data and the mutations live in `../page.tsx`.
 *
 * Progressive disclosure: the state sentence and its mark first; the readings
 * (worst first); the actions that help the CURRENT alerts only (none when all
 * is well); the thresholds behind "Change thresholds".
 */

import { Button, Input, Select, SelectItem } from "@heroui/react";
import {
  Activity,
  ArrowLeftRight,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  HardDriveDownload,
  MemoryStick,
  RadioTower,
  Timer,
  Archive,
  type LucideIcon,
} from "lucide-react";
import { formatBytes } from "@synap-core/types/value-format";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CommandLine } from "../../../_lib/command-line";
import { navHref } from "../../../../lib/console-nav";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ResourceRow,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { HEALTH_CATALOGS } from "./copy";
import {
  actionResultLine,
  actionsFor,
  checkThresholdDraft,
  draftFrom,
  markLabel,
  markTone,
  metricName,
  readingRows,
  serviceName,
  stateSentence,
  THRESHOLD_METRICS,
  type ActionCard,
  type HostAction,
  type PodHealthView,
  type ThresholdDraft,
  type ThresholdProblem,
  type ThresholdMetric,
  type Thresholds,
} from "./health-model";

const READING_ICONS: Record<string, LucideIcon> = {
  readings: RadioTower,
  memory: MemoryStick,
  swap: ArrowLeftRight,
  memoryPressure: Gauge,
  disk: HardDrive,
  postgresConnections: Database,
  cpuPressure: Cpu,
  ioPressure: HardDriveDownload,
  load: Activity,
  databaseSize: Database,
  eventLoop: Timer,
  backup: Archive,
};

export type HealthBodyState =
  | { kind: "loading" }
  | { kind: "failed"; onRetry: () => void }
  | { kind: "unreadable"; onRetry: () => void }
  | { kind: "ready"; view: PodHealthView };

export interface HealthHandlers {
  onHostAction: (action: HostAction, service?: string) => void;
  /** The action whose request is being sent right now, if any. */
  sendingAction: HostAction | null;
  onSaveThresholds: (patch: Thresholds) => void;
  savingThresholds: boolean;
}

export function HealthBody({
  state,
  handlers,
  now = Date.now(),
}: {
  state: HealthBodyState;
  handlers: HealthHandlers;
  now?: number;
}) {
  const t = useT(HEALTH_CATALOGS);
  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <SectionCard title={t("section.readings")}>
          <ResourceRowSkeleton count={4} />
        </SectionCard>
      </div>
    );
  }
  if (state.kind !== "ready") {
    // A failed read is an error with Retry, never an empty healthy page.
    return (
      <SectionCard title={t("section.readings")}>
        <ResourceRowError
          message={
            state.kind === "failed" ? t("read.failed") : t("read.unreadable")
          }
          onRetry={state.onRetry}
        />
      </SectionCard>
    );
  }
  return <HealthReady view={state.view} handlers={handlers} now={now} />;
}

function HealthReady({
  view,
  handlers,
  now,
}: {
  view: PodHealthView;
  handlers: HealthHandlers;
  now: number;
}) {
  const t = useT(HEALTH_CATALOGS);
  const locale = useConsoleLocale();
  const { sentence, more } = stateSentence(t, view, locale, now);
  const tone = markTone(view.level);
  const rows = readingRows(t, view, locale, now);
  const cards = actionsFor(view);
  const [showThresholds, setShowThresholds] = useState(false);
  const router = useRouter();

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-live="polite"
        className="flex flex-wrap items-center gap-3"
        data-testid="health-state"
      >
        {tone && (
          <StatusPill kind={tone} label={markLabel(t, view.level) ?? ""} />
        )}
        <p className="text-[15px] font-medium text-foreground">{sentence}</p>
        {more && <p className="text-[13px] text-foreground/65">{more}</p>}
      </section>

      <SectionCard
        title={t("section.readings")}
        hint={t("section.readings.hint")}
      >
        <div className="flex flex-col divide-y divide-foreground/[0.05]">
          {rows.map((row) => {
            const reading = view.readings.find((r) => r.key === row.key);
            const Icon = READING_ICONS[reading?.kind ?? ""] ?? Gauge;
            const judged = reading?.alerting === true || row.key === "backup";
            return (
              <ResourceRow
                key={row.key}
                Icon={Icon}
                primary={row.name}
                secondary={
                  row.value && row.detail
                    ? t("row.valueDetail", {
                        value: row.value,
                        detail: row.detail,
                      })
                    : (row.value ?? row.detail ?? undefined)
                }
                status={
                  row.tone && row.markLabel && judged
                    ? { kind: row.tone, label: row.markLabel }
                    : undefined
                }
                // The backup reading is a door to the page that owns it.
                onSelect={
                  row.key === "backup"
                    ? () => router.push(navHref("backups"))
                    : undefined
                }
              />
            );
          })}
        </div>
      </SectionCard>

      {cards.length > 0 && (
        <SectionCard
          title={t("section.actions")}
          hint={t("section.actions.hint")}
        >
          <div className="flex flex-col gap-4">
            {cards.map((card) => (
              <ActionCardView
                key={card.kind === "host" ? card.action : card.kind}
                card={card}
                view={view}
                handlers={handlers}
                now={now}
              />
            ))}
          </div>
        </SectionCard>
      )}

      <div>
        <Button
          size="sm"
          radius="md"
          variant="flat"
          aria-expanded={showThresholds}
          onPress={() => setShowThresholds((v) => !v)}
        >
          {showThresholds ? t("thresholds.hide") : t("thresholds.show")}
        </Button>
      </div>
      {showThresholds && (
        <ThresholdsForm
          thresholds={view.thresholds}
          saving={handlers.savingThresholds}
          onSave={handlers.onSaveThresholds}
        />
      )}
    </div>
  );
}

function ActionCardView({
  card,
  view,
  handlers,
  now,
}: {
  card: ActionCard;
  view: PodHealthView;
  handlers: HealthHandlers;
  now: number;
}) {
  const t = useT(HEALTH_CATALOGS);
  const locale = useConsoleLocale();
  const waiting = view.actions.pending !== null;

  if (card.kind === "pause") {
    return (
      <ActionBlock
        title={t("action.pause.title")}
        body={t("action.pause.body")}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            as={Link}
            href={navHref("runs")}
            size="sm"
            radius="md"
            variant="flat"
          >
            {t("action.pause.runs")}
          </Button>
          <Button
            as={Link}
            href={navHref("rules")}
            size="sm"
            radius="md"
            variant="flat"
          >
            {t("action.pause.rules")}
          </Button>
          <Button
            as={Link}
            href={navHref("agents")}
            size="sm"
            radius="md"
            variant="flat"
          >
            {t("action.pause.agents")}
          </Button>
        </div>
      </ActionBlock>
    );
  }

  if (card.kind === "readings") {
    return (
      <ActionBlock
        title={t("action.readings.title")}
        body={t("action.readings.body")}
      >
        <CommandLine command="synap doctor" />
      </ActionBlock>
    );
  }

  if (card.kind === "restart") {
    return (
      <RestartBlock
        services={card.services}
        view={view}
        handlers={handlers}
        now={now}
      />
    );
  }

  const freed =
    card.freesBytes !== null && card.freesBytes > 0
      ? formatBytes(card.freesBytes, { locale })
      : null;
  const isCache = card.action === "prune-build-cache";
  const body = isCache
    ? freed
      ? t("action.buildCache.body", { bytes: freed })
      : t("action.buildCache.bodyUnknown")
    : freed
      ? t("action.images.body", { bytes: freed })
      : t("action.images.bodyUnknown");
  const result = actionResultLine(t, card.action, view, locale, now);
  return (
    <ActionBlock
      title={isCache ? t("action.buildCache.title") : t("action.images.title")}
      body={body}
      result={result}
    >
      <Button
        size="sm"
        radius="md"
        variant="flat"
        isLoading={handlers.sendingAction === card.action}
        isDisabled={waiting || handlers.sendingAction !== null}
        onPress={() => handlers.onHostAction(card.action)}
      >
        {isCache ? t("action.buildCache.run") : t("action.images.run")}
      </Button>
    </ActionBlock>
  );
}

function RestartBlock({
  services,
  view,
  handlers,
  now,
}: {
  services: string[];
  view: PodHealthView;
  handlers: HealthHandlers;
  now: number;
}) {
  const t = useT(HEALTH_CATALOGS);
  const locale = useConsoleLocale();
  const [service, setService] = useState(services[0] ?? "");
  const [confirming, setConfirming] = useState(false);
  const name = serviceName(t, service);
  const waiting = view.actions.pending !== null;
  const result = actionResultLine(t, "restart-service", view, locale, now);
  return (
    <ActionBlock
      title={t("action.restart.title")}
      body={t("action.restart.body")}
      result={result}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          radius="md"
          variant="bordered"
          className="max-w-[220px]"
          aria-label={t("action.restart.select")}
          selectedKeys={service ? [service] : []}
          onSelectionChange={(keys) => {
            const k = Array.from(keys as Set<string>)[0];
            if (k) setService(k);
          }}
        >
          {services.map((s) => (
            <SelectItem key={s}>{serviceName(t, s)}</SelectItem>
          ))}
        </Select>
        <Button
          size="sm"
          radius="md"
          variant="flat"
          isDisabled={!service || waiting || handlers.sendingAction !== null}
          isLoading={handlers.sendingAction === "restart-service"}
          onPress={() => setConfirming(true)}
        >
          {t("action.restart.run")}
        </Button>
      </div>
      <ConfirmModal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          handlers.onHostAction("restart-service", service);
        }}
        title={t("confirm.restart.title", { service: name })}
        consequence={t("confirm.restart.body", { service: name })}
        confirmLabel={t("confirm.restart.confirm", { service: name })}
        confirmColor="warning"
      />
    </ActionBlock>
  );
}

function ActionBlock({
  title,
  body,
  result,
  children,
}: {
  title: string;
  body: string;
  result?: {
    text: string;
    tone: Parameters<typeof StatusPill>[0]["kind"];
  } | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-[13px] font-medium text-foreground">{title}</h4>
        <p className="text-[12.5px] text-foreground/65">{body}</p>
      </div>
      {result && (
        <div>
          <StatusPill kind={result.tone} label={result.text} />
        </div>
      )}
      {children}
    </div>
  );
}

function ThresholdsForm({
  thresholds,
  saving,
  onSave,
}: {
  thresholds: Thresholds;
  saving: boolean;
  onSave: (patch: Thresholds) => void;
}) {
  const t = useT(HEALTH_CATALOGS);
  const [draft, setDraft] = useState<ThresholdDraft>(() =>
    draftFrom(thresholds)
  );
  const [problems, setProblems] = useState<
    Partial<Record<ThresholdMetric, ThresholdProblem>>
  >({});
  const set = (m: ThresholdMetric, field: "warn" | "critical", value: string) =>
    setDraft((d) => ({ ...d, [m]: { ...d[m], [field]: value } }));

  return (
    <SectionCard title={t("section.thresholds")} hint={t("thresholds.hint")}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const checked = checkThresholdDraft(draft);
          if (!checked.ok) {
            setProblems(checked.problems);
            return;
          }
          setProblems({});
          onSave(checked.patch);
        }}
      >
        {THRESHOLD_METRICS.map((m) => {
          const problem = problems[m];
          return (
            <fieldset key={m} className="flex flex-col gap-1">
              <legend className="text-[13px] font-medium text-foreground">
                {metricName(t, m)}
              </legend>
              <div className="flex flex-wrap gap-3">
                <Input
                  size="sm"
                  radius="md"
                  type="number"
                  min={1}
                  max={100}
                  label={t("thresholds.warn")}
                  className="max-w-[140px]"
                  value={draft[m].warn}
                  onValueChange={(v) => set(m, "warn", v)}
                  isInvalid={!!problem}
                  endContent={t("unit.percent")}
                />
                <Input
                  size="sm"
                  radius="md"
                  type="number"
                  min={1}
                  max={100}
                  label={t("thresholds.critical")}
                  className="max-w-[140px]"
                  value={draft[m].critical}
                  onValueChange={(v) => set(m, "critical", v)}
                  isInvalid={!!problem}
                  endContent={t("unit.percent")}
                />
              </div>
              {problem && (
                <p role="alert" className="text-[12px] text-status-down">
                  {t(`problem.${problem}`)}
                </p>
              )}
              {m === "disk" && (
                <p className="text-[12px] text-foreground/65">
                  {t("thresholds.diskNote")}
                </p>
              )}
            </fieldset>
          );
        })}
        <div>
          <Button
            type="submit"
            size="sm"
            radius="md"
            color="primary"
            isLoading={saving}
          >
            {t("thresholds.save")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
