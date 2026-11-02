"use client";

/**
 * "How your AIs act" — the pod's two defaults for every agent, switched
 * through their own doors (`governanceRules.setReversibleDefault`,
 * `setOwnOrganiseDefault`: pod admin only, a person's act), and under them the
 * platform floors that ask whatever the switches say
 * (`governanceRules.platformDefaults`), said once. Anyone signed in reads it;
 * a member sees the switches locked and who may change them (`canManage`).
 *
 * The desktop app's Settings › Trust rules draws the same two dials
 * (`TrustDefaultsSection`): one store, two surfaces that run the pod.
 */
import { Switch, addToast } from "@heroui/react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { SectionCard } from "../../../components/section-card";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import {
  dialState,
  podDefaultsManageable,
  type DialQuery,
  type DialSave,
} from "./pod-defaults-model";

const CATALOGS = { en, fr };

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
  const setReversible = trpc.governanceRules.setReversibleDefault.useMutation({
    onSuccess: (res) => {
      void utils.governanceRules.reversibleDefault.invalidate();
      // Every agent's sentence reads the pod default.
      void utils.agentUsers.governance.invalidate();
      onSaved(t("podDefaults.reversible.label"))(res);
    },
    onError: onFailed,
  });
  const setOwnOrganise = trpc.governanceRules.setOwnOrganiseDefault.useMutation(
    {
      onSuccess: (res) => {
        void utils.governanceRules.ownOrganiseDefault.invalidate();
        onSaved(t("podDefaults.ownOrganise.label"))(res);
      },
      onError: onFailed,
    }
  );

  const canManage = podDefaultsManageable(reversible, ownOrganise);
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
