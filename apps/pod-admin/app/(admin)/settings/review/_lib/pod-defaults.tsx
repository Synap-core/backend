"use client";

/**
 * "How your AIs act" — the pod's defaults for every agent, switched through
 * their own doors (`governanceRules.setReversibleDefault`,
 * `setOwnOrganiseDefault`, and per floor family `setPodFloorDefault`, worded
 * by `POD_DEFAULT_WORDS`), the governance numbers (`setPodSetting`); each a
 * pod admin's act with its proof of presence. Under them the platform floors
 * that ask whatever the switches say (`governanceRules.platformDefaults`), said
 * once. Anyone signed in reads it; a member sees the switches locked and who
 * may change them (`canManage`).
 *
 * The desktop app's Settings › Trust rules draws the same two dials
 * (`TrustDefaultsSection`): one store, two surfaces that run the pod.
 */
import { useState } from "react";
import { Button, Input, Switch, addToast } from "@heroui/react";
import {
  AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
  AGENT_DEFINES_KINDS_CLASS_PATTERN,
  POD_DEFAULT_WORDS,
} from "@synap-core/types/governance-rules";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { SectionCard } from "../../../components/section-card";
import { FormModal } from "../../../components/form-modal";
import {
  useSetOwnOrganiseDefault,
  useSetPodFloorDefault,
  useSetPodSetting,
  useSetReversibleDefault,
} from "../../../../_lib/presence/use-sensitive-actions";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import {
  dialState,
  floorDial,
  floorSave,
  podDefaultsManageable,
  settingState,
  parseSetting,
  type DialQuery,
  type DialSave,
  type SettingState,
} from "./pod-defaults-model";

const CATALOGS = { en, fr };

/** The floor families a pod may switch, each worded by `POD_DEFAULT_WORDS`. */
const FLOOR_FAMILIES = [
  AGENT_DEFINES_KINDS_CLASS_PATTERN,
  AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
] as const;

/** The governance numbers a person sets here, and the words of each. */
const SETTINGS = [
  { key: "governance.own_work_fresh_hours", words: "ownWorkHours" },
  { key: "governance.project_evidence_min", words: "evidenceMin" },
] as const;

export function PodDefaults() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const reversible = trpc.governanceRules.reversibleDefault.useQuery(
    undefined,
    { staleTime: 30_000 }
  );
  const ownOrganise = trpc.governanceRules.ownOrganiseDefault.useQuery(
    undefined,
    { staleTime: 30_000 }
  );
  const switchable = trpc.governanceRules.podFloorDefaults.useQuery(
    undefined,
    { staleTime: 30_000 }
  );
  const floors = trpc.governanceRules.platformDefaults.useQuery(undefined, {
    staleTime: 300_000,
  });

  const onSaved = (name: string) => (res: { enabled: boolean }) =>
    addToast({
      title: t(res.enabled ? "podDefaults.turnedOn" : "podDefaults.turnedOff", {
        name,
      }),
      color: "success",
    });
  const onFailed = (err: unknown) => {
    if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
      return;
    addToast({
      title: t("podDefaults.notChanged"),
      description: t("podDefaults.notChangedHint"),
      color: "danger",
    });
  };
  // Both defaults carry the proof of presence (W3 slice 3): sensitive actions.
  const setReversible = useSetReversibleDefault({
    onSuccess: (res) => {
      void utils.governanceRules.reversibleDefault.invalidate();
      // Every agent's sentence reads the pod default.
      void utils.agentUsers.governance.invalidate();
      onSaved(t("podDefaults.reversible.label"))(res);
    },
    onError: onFailed,
  });
  const setOwnOrganise = useSetOwnOrganiseDefault({
    onSuccess: (res) => {
      void utils.governanceRules.ownOrganiseDefault.invalidate();
      onSaved(t("podDefaults.ownOrganise.label"))(res);
    },
    onError: onFailed,
  });

  const setFloor = useSetPodFloorDefault({
    onSuccess: (res, input) => {
      void utils.governanceRules.podFloorDefaults.invalidate();
      onSaved(POD_DEFAULT_WORDS[input.pattern]?.label ?? input.pattern)(res);
    },
    onError: onFailed,
  });

  const canManage = podDefaultsManageable(
    reversible,
    ownOrganise,
    floorDial(switchable, AGENT_DEFINES_KINDS_CLASS_PATTERN)
  );
  return (
    <SectionCard title={t("podDefaults.title")} hint={t("podDefaults.hint")}>
      <ul className="-mx-2 divide-y divide-foreground/[0.05]">
        <DialRow
          label={t("podDefaults.reversible.label")}
          line={t("podDefaults.reversible.line")}
          read={reversible}
          save={setReversible}
          onRetry={() => void reversible.refetch()}
          onChange={(enabled) => setReversible.mutate({ enabled })}
        />
        <DialRow
          label={t("podDefaults.ownOrganise.label")}
          line={t("podDefaults.ownOrganise.line")}
          read={ownOrganise}
          save={setOwnOrganise}
          onRetry={() => void ownOrganise.refetch()}
          onChange={(enabled) => setOwnOrganise.mutate({ enabled })}
        />
        {FLOOR_FAMILIES.map((pattern) => (
          <DialRow
            key={pattern}
            label={POD_DEFAULT_WORDS[pattern]!.label}
            line={POD_DEFAULT_WORDS[pattern]!.line}
            read={floorDial(switchable, pattern)}
            save={floorSave(setFloor, pattern)}
            onRetry={() => void switchable.refetch()}
            onChange={(enabled) => setFloor.mutate({ pattern, enabled })}
          />
        ))}
      </ul>
      <p className="mt-3 text-[12px] font-medium text-foreground/80">
        {t("podDefaults.numbers")}
      </p>
      <ul className="-mx-2 divide-y divide-foreground/[0.05]">
        {SETTINGS.map((s) => (
          <SettingRow
            key={s.key}
            settingKey={s.key}
            label={t(`podDefaults.${s.words}.label`)}
            line={t(`podDefaults.${s.words}.line`)}
            say={(n) => t(`podDefaults.${s.words}.value`, { n })}
            state={settingState(switchable, s.key)}
            onRetry={() => void switchable.refetch()}
          />
        ))}
      </ul>
      {canManage === false && (
        <p className="mt-2 text-[12px] text-foreground/65">
          {t("podDefaults.adminOnly")}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-1.5 border-t border-foreground/[0.05] pt-3">
        <p className="text-[12px] font-medium text-foreground/80">
          {t("podDefaults.floors")}
        </p>
        {floors.isError ? (
          <p className="text-[12px] text-status-down">
            {t("podDefaults.floorsFailed")}{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => void floors.refetch()}
            >
              {t("retry")}
            </button>
          </p>
        ) : floors.data ? (
          <ul className="flex flex-col gap-0.5 text-[12px] text-foreground/65">
            {floors.data.alwaysPropose.map((f) => (
              <li key={f.key}>{f.label}</li>
            ))}
          </ul>
        ) : (
          <div className="h-10 rounded bg-foreground/[0.04] shimmer-pulse" />
        )}
      </div>
    </SectionCard>
  );
}

/**
 * One default as a row. A failed READ is the failed mark with its retry, never
 * a calm OFF switch (an empty result and a failed read are different facts).
 */
function DialRow({
  label,
  line,
  read,
  save,
  onRetry,
  onChange,
}: {
  label: string;
  line: string;
  read: DialQuery;
  save: DialSave;
  onRetry: () => void;
  onChange: (enabled: boolean) => void;
}) {
  const t = useT(CATALOGS);
  const state = dialState(read, save);
  return (
    <li className="flex min-h-14 items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-foreground">
          {label}
        </span>
        <span className="block text-[12px] text-foreground/65">{line}</span>
      </span>
      {state.kind === "failed" ? (
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-status-down">
          {t("podDefaults.failed")}
          <button
            type="button"
            className="min-h-10 font-medium text-primary underline-offset-2 hover:underline"
            onClick={onRetry}
          >
            {t("retry")}
          </button>
        </span>
      ) : state.kind === "loading" ? (
        <div className="h-6 w-11 shrink-0 rounded-full bg-foreground/10 shimmer-pulse" />
      ) : (
        <>
          <span className="hidden text-[12px] text-foreground/65 sm:inline">
            {state.on ? t("podDefaults.on") : t("podDefaults.off")}
          </span>
          <Switch
            size="sm"
            isSelected={state.on}
            isDisabled={!state.canManage || state.saving}
            onValueChange={onChange}
            aria-label={label}
          />
        </>
      )}
    </li>
  );
}

/**
 * One governance number as a row: its value, and Change for a pod admin (a
 * small form, the range said under the field). A failed read is the failed
 * mark with its retry, never a guessed default.
 */
function SettingRow({
  settingKey,
  label,
  line,
  say,
  state,
  onRetry,
}: {
  settingKey: (typeof SETTINGS)[number]["key"];
  label: string;
  line: string;
  say: (n: number) => string;
  state: SettingState;
  onRetry: () => void;
}) {
  const t = useT(CATALOGS);
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex min-h-14 items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-foreground">
          {label}
        </span>
        <span className="block text-[12px] text-foreground/65">{line}</span>
      </span>
      {state.kind === "failed" ? (
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-status-down">
          {t("podDefaults.failed")}
          <button
            type="button"
            className="min-h-10 font-medium text-primary underline-offset-2 hover:underline"
            onClick={onRetry}
          >
            {t("retry")}
          </button>
        </span>
      ) : state.kind === "loading" ? (
        <div className="h-6 w-16 shrink-0 rounded bg-foreground/10 shimmer-pulse" />
      ) : (
        <>
          <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-foreground">
            {say(state.value)}
          </span>
          {state.canManage && (
            <Button
              size="sm"
              variant="flat"
              radius="md"
              aria-label={t("podDefaults.changeNamed", { name: label })}
              onPress={() => setEditing(true)}
            >
              {t("podDefaults.change")}
            </Button>
          )}
          {editing && (
            <SettingModal
              settingKey={settingKey}
              label={label}
              state={state}
              onClose={() => setEditing(false)}
            />
          )}
        </>
      )}
    </li>
  );
}

function SettingModal({
  settingKey,
  label,
  state,
  onClose,
}: {
  settingKey: (typeof SETTINGS)[number]["key"];
  label: string;
  state: Extract<SettingState, { kind: "ready" }>;
  onClose: () => void;
}) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(String(state.value));
  const [error, setError] = useState<string | null>(null);
  const save = useSetPodSetting({
    onSuccess: () => {
      void utils.governanceRules.podFloorDefaults.invalidate();
      addToast({
        title: t("podDefaults.saved", { name: label }),
        color: "success",
      });
      onClose();
    },
    onError: (err) => {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      setError(err instanceof Error ? err.message : t("podDefaults.notChanged"));
    },
  });
  const n = parseSetting(draft, state);
  const range = t("podDefaults.range", { min: state.min, max: state.max });
  return (
    <FormModal
      title={label}
      submitLabel={t("podDefaults.save")}
      isPending={save.isPending}
      canSubmit={n !== null && n !== state.value}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        if (n !== null) save.mutate({ key: settingKey, value: n });
      }}
    >
      <Input
        autoFocus
        type="number"
        size="sm"
        label={label}
        className="max-w-40"
        min={state.min}
        max={state.max}
        value={draft}
        onValueChange={setDraft}
        isInvalid={n === null}
        errorMessage={range}
        description={range}
      />
    </FormModal>
  );
}
