"use client";

/**
 * "How your AIs act" — the pod's switches for every agent, each through its
 * own door (`governanceRules.setReversibleDefault`, `setOwnOrganiseDefault`,
 * and per floor family `setPodFloorDefault`), worded by the one catalog
 * (`podSwitchWords`, `@synap-core/types/governance-rules`); the governance
 * numbers the read lists (`setPodSetting`), each under the switch it is a
 * parameter of or on its own. Every write is a pod admin's act with its proof
 * of presence. Under them the platform floors that still always ask
 * (`governanceRules.platformDefaults`, less what a switch that is on lifts).
 * Anyone signed in reads it; a member sees everything locked and who may
 * change it (`canManage`).
 *
 * The desktop app's Settings › Trust rules draws the same switches
 * (`TrustDefaultsSection`): one store, one catalog, two surfaces.
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, Input, Switch, addToast } from "@heroui/react";
import {
  OWN_ORGANISE_CLASS_PATTERN,
  REVERSIBLE_CLASS_PATTERN,
  podSettingWords,
  podSwitchWords,
  type RootSwitchPattern,
} from "@synap-core/types/governance-rules";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "../../../../../lib/trpc";
import { navHref } from "../../../../../lib/console-nav";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { SectionCard } from "../../../components/section-card";
import { FormModal } from "../../../components/form-modal";
import {
  useSetOwnOrganiseDefault,
  useSetPodFloorDefault,
  useSetPodSetting,
  useSetReversibleDefault,
} from "../../../../_lib/presence/use-sensitive-actions";
import {
  useConsoleLocale,
  useT,
} from "../../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import {
  dialState,
  floorDial,
  floorSave,
  floorsStillAsking,
  parameterValue,
  parseSetting,
  podDefaultsManageable,
  settingState,
  settingsOf,
  type DialQuery,
  type DialSave,
  type PodSetting,
  type SettingState,
} from "./pod-defaults-model";

const CATALOGS = { en, fr };

export function PodDefaults() {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const utils = trpc.useUtils();
  const reversible = trpc.governanceRules.reversibleDefault.useQuery(
    undefined,
    { staleTime: 30_000 }
  );
  const ownOrganise = trpc.governanceRules.ownOrganiseDefault.useQuery(
    undefined,
    { staleTime: 30_000 }
  );
  const switchable = trpc.governanceRules.podFloorDefaults.useQuery(undefined, {
    staleTime: 30_000,
  });
  const floors = trpc.governanceRules.platformDefaults.useQuery(undefined, {
    staleTime: 300_000,
  });

  const words = (pattern: RootSwitchPattern) =>
    podSwitchWords(pattern, {
      locale,
      ownWorkHours: parameterValue(switchable, OWN_ORGANISE_CLASS_PATTERN),
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
  // Every switch carries the proof of presence (W3 slice 3): sensitive actions.
  const setReversible = useSetReversibleDefault({
    onSuccess: (res) => {
      void utils.governanceRules.reversibleDefault.invalidate();
      // Every agent's sentence reads the pod default.
      void utils.agentUsers.governance.invalidate();
      onSaved(words(REVERSIBLE_CLASS_PATTERN).label)(res);
    },
    onError: onFailed,
  });
  const setOwnOrganise = useSetOwnOrganiseDefault({
    onSuccess: (res) => {
      void utils.governanceRules.ownOrganiseDefault.invalidate();
      onSaved(words(OWN_ORGANISE_CLASS_PATTERN).label)(res);
    },
    onError: onFailed,
  });
  const setFloor = useSetPodFloorDefault({
    onSuccess: (res, input) => {
      void utils.governanceRules.podFloorDefaults.invalidate();
      // The agent matrix reads whether a floor yields.
      void utils.governanceRules.matrix.invalidate();
      onSaved(words(input.pattern).label)(res);
    },
    onError: onFailed,
  });

  const canManage = podDefaultsManageable(reversible, ownOrganise, switchable);
  const settingRows = (pattern: string | null) =>
    settingsOf(switchable, pattern).map((s) => (
      <SettingRow
        key={s.key}
        setting={s}
        state={settingState(switchable, s.key)}
        nested={pattern !== null}
        onRetry={() => void switchable.refetch()}
      />
    ));
  const rulesDoor = (
    <Link
      href={navHref("approvals")}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {t("podDefaults.rulesDoor")}
    </Link>
  );
  return (
    <SectionCard title={t("podDefaults.title")} hint={t("podDefaults.hint")}>
      <ul className="-mx-2 divide-y divide-foreground/[0.05]">
        <DialRow
          words={words(REVERSIBLE_CLASS_PATTERN)}
          read={reversible}
          save={setReversible}
          onRetry={() => void reversible.refetch()}
          onChange={(enabled) => setReversible.mutate({ enabled })}
        />
        <DialRow
          words={words(OWN_ORGANISE_CLASS_PATTERN)}
          read={ownOrganise}
          save={setOwnOrganise}
          onRetry={() => void ownOrganise.refetch()}
          onChange={(enabled) => setOwnOrganise.mutate({ enabled })}
        >
          {settingRows(OWN_ORGANISE_CLASS_PATTERN)}
        </DialRow>
        {switchable.data ? (
          switchable.data.families.map((family) => (
            <DialRow
              key={family.pattern}
              words={words(family.pattern)}
              door={rulesDoor}
              read={floorDial(switchable, family.pattern)}
              save={floorSave(setFloor, family.pattern)}
              onRetry={() => void switchable.refetch()}
              onChange={(enabled) =>
                setFloor.mutate({ pattern: family.pattern, enabled })
              }
            />
          ))
        ) : switchable.isError ? (
          <li className="flex min-h-14 items-center gap-2 px-3 py-2 text-[12px] text-status-down">
            {t("podDefaults.switchesFailed")}
            <button
              type="button"
              className="min-h-10 font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => void switchable.refetch()}
            >
              {t("retry")}
            </button>
          </li>
        ) : (
          <li className="px-3 py-2">
            <div className="h-10 rounded bg-foreground/[0.04] shimmer-pulse" />
          </li>
        )}
        {settingRows(null)}
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
            {floorsStillAsking(floors.data.alwaysPropose, switchable).map(
              (f) => (
                <li key={f.key}>{f.label}</li>
              )
            )}
          </ul>
        ) : (
          <div className="h-10 rounded bg-foreground/[0.04] shimmer-pulse" />
        )}
      </div>
    </SectionCard>
  );
}

/**
 * One switch as a row; what it reads (`children`) sits under it. A failed READ
 * is the failed mark with its retry, never a calm OFF switch (an empty result
 * and a failed read are different facts).
 */
function DialRow({
  words,
  door,
  read,
  save,
  onRetry,
  onChange,
  children,
}: {
  words: { label: string; line: string };
  /** Where what the switch hands over to is (the approval rules). */
  door?: ReactNode;
  read: DialQuery;
  save: DialSave;
  onRetry: () => void;
  onChange: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  const t = useT(CATALOGS);
  const state = dialState(read, save);
  return (
    <li className="flex flex-col">
      <div className="flex min-h-14 items-center gap-3 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-foreground">
            {words.label}
          </span>
          <span className="block text-[12px] text-foreground/65">
            {words.line} {door}
          </span>
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
              aria-label={words.label}
            />
          </>
        )}
      </div>
      {children}
    </li>
  );
}

/**
 * One governance number: its value, and Change for a pod admin (a small form,
 * the row's explanation and the range said in it). Nested under the switch it
 * is a parameter of. A failed read is the failed mark with its retry, never a
 * guessed default.
 */
function SettingRow({
  setting,
  state,
  nested,
  onRetry,
}: {
  setting: PodSetting;
  state: SettingState;
  nested: boolean;
  onRetry: () => void;
}) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const words = podSettingWords(setting.key, locale);
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={`flex min-h-12 items-center gap-3 py-2 pr-3 ${nested ? "pl-8" : "pl-3"}`}
    >
      <span className="min-w-0 flex-1 text-[12.5px] text-foreground/80">
        {words.label}
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
            {words.value(state.value)}
          </span>
          {state.canManage && (
            <Button
              size="sm"
              variant="flat"
              radius="md"
              aria-label={t("podDefaults.changeNamed", { name: words.label })}
              onPress={() => setEditing(true)}
            >
              {t("podDefaults.change")}
            </Button>
          )}
          {editing && (
            <SettingModal
              settingKey={setting.key}
              words={words}
              state={state}
              onClose={() => setEditing(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

function SettingModal({
  settingKey,
  words,
  state,
  onClose,
}: {
  settingKey: string;
  words: ReturnType<typeof podSettingWords>;
  state: Extract<SettingState, { kind: "ready" }>;
  onClose: () => void;
}) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(String(state.value));
  const [error, setError] = useState<string | null>(null);
  const range = t("podDefaults.range", { min: state.min, max: state.max });
  const save = useSetPodSetting({
    onSuccess: () => {
      void utils.governanceRules.podFloorDefaults.invalidate();
      addToast({
        title: t("podDefaults.saved", { name: words.label }),
        color: "success",
      });
      onClose();
    },
    onError: (err) => {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      // The pod's own words name its setting key: say the range instead.
      setError(
        err instanceof TRPCClientError && err.data?.code === "BAD_REQUEST"
          ? range
          : t("podDefaults.notChanged")
      );
    },
  });
  const n = parseSetting(draft, state);
  return (
    <FormModal
      title={words.label}
      submitLabel={t("podDefaults.save")}
      isPending={save.isPending}
      canSubmit={n !== null && n !== state.value}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        if (n !== null)
          save.mutate({ key: settingKey as SettingKey, value: n });
      }}
    >
      {words.line && (
        <p className="text-[12.5px] leading-relaxed text-foreground/65">
          {words.line}
        </p>
      )}
      <Input
        autoFocus
        type="number"
        size="sm"
        label={words.unit ?? undefined}
        aria-label={words.unit ?? words.label}
        className="max-w-40"
        min={state.min}
        max={state.max}
        value={draft}
        onValueChange={setDraft}
        isInvalid={n === null}
        description={range}
      />
    </FormModal>
  );
}

/** The keys `setPodSetting` takes (the read's keys are that closed set). */
type SettingKey = Parameters<
  ReturnType<typeof useSetPodSetting>["mutate"]
>[0]["key"];
