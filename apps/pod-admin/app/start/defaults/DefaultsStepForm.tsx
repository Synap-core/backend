"use client";

/**
 * The defaults step (`/start/defaults`, founder 5 Nov 2026, session
 * b064a220): the pod's notable defaults in one short list, each with its
 * value and one line on what it does, changed in one go.
 *
 *  - Each switch writes through its setting's OWN door, the same hooks the
 *    console uses (the presence mode, the two AI defaults with their proof of
 *    presence, proactive AI, the Library keep-alive). This step writes no
 *    setting of its own.
 *  - A change that lands says nothing: the switch is the mark. A refusal
 *    stays on its row with Try again until acted on (rule feedback-and-forms
 *    §1); declining the passkey changes nothing and says nothing (the dialog
 *    already did).
 *  - Under the presence row, the person's own factors: with no passkey and
 *    no Relay Face ID yet, an invite to add one (`presence.factors`).
 *  - A failed read is that row's failed mark with Try again, never a default.
 *  - Continue only records that the owner went past the step
 *    (`onboarding.recordStartStep`): leaving every switch alone keeps the
 *    defaults.
 */

import { Button, Switch } from "@heroui/react";
import { TRPCClientError } from "@trpc/client";
import Link from "next/link";
import { useState } from "react";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { useT } from "../../../lib/i18n/locale-provider";
import { trpc } from "../../../lib/trpc";
import {
  PresenceDeclined,
  presenceRefusal,
} from "../../_lib/presence/presence-model";
import { useSetPresenceMode } from "../../_lib/presence/use-factor-doors";
import {
  useSetOwnOrganiseDefault,
  useSetReversibleDefault,
} from "../../_lib/presence/use-sensitive-actions";
import { PASSKEYS_PATH } from "../../settings/security/passkeys-path";
import { SECOND_WAY_HREF } from "../../settings/security/two-factor-path";
import { en, fr } from "./_lib/copy";
import {
  defaultsStepRows,
  enabledSave,
  factorNote,
  libraryDial,
  presenceDial,
  presenceSave,
  proactiveDial,
  proactiveInput,
  type DefaultRow,
  type DefaultRowView,
  type FactorNote,
} from "./_lib/defaults-model";

/** A change the pod refused, kept on its row until acted on. */
interface Refused {
  on: boolean;
  /** Refused for want of a proof of presence (not declined by the person). */
  presence: boolean;
}

const CATALOGS = { en, fr };

/** Record going past the step. Throws when the pod did not record it. */
async function recordDefaultsStep(): Promise<void> {
  const res = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "defaults" }),
  });
  if (!res.ok) throw new Error(`The pod answered ${res.status}.`);
}

export function DefaultsStepForm() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false);
  const [recordFailed, setRecordFailed] = useState(false);
  const [refused, setRefused] = useState<Partial<Record<DefaultRow, Refused>>>(
    {}
  );

  const settled = (row: DefaultRow) =>
    setRefused(({ [row]: _settled, ...rest }) => rest);
  const onFailed = (row: DefaultRow, on: boolean) => (err: unknown) => {
    if (err instanceof PresenceDeclined) return;
    if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
      return;
    setRefused((r) => ({
      ...r,
      [row]: { on, presence: presenceRefusal(err) !== null },
    }));
  };

  const presence = trpc.presence.mode.useQuery(undefined, { retry: false });
  const reversible = trpc.governanceRules.reversibleDefault.useQuery(
    undefined,
    { retry: false }
  );
  const ownOrganise = trpc.governanceRules.ownOrganiseDefault.useQuery(
    undefined,
    { retry: false }
  );
  const proactive = trpc.proactive.getPodDefaults.useQuery(undefined, {
    retry: false,
  });
  const library = trpc.proactive.getLibraryKeepAlive.useQuery(undefined, {
    retry: false,
  });
  const factors = trpc.presence.factors.useQuery(undefined, { retry: false });

  const setPresence = useSetPresenceMode({
    onSuccess: () => {
      settled("presence");
      void utils.presence.mode.invalidate();
    },
    onError: (err, input) =>
      onFailed("presence", input.mode === "enforce")(err),
  });
  const setReversible = useSetReversibleDefault({
    onSuccess: () => {
      settled("reversible");
      void utils.governanceRules.reversibleDefault.invalidate();
      void utils.agentUsers.governance.invalidate();
    },
    onError: (err, input) => onFailed("reversible", input.enabled)(err),
  });
  const setOwnOrganise = useSetOwnOrganiseDefault({
    onSuccess: () => {
      settled("ownOrganise");
      void utils.governanceRules.ownOrganiseDefault.invalidate();
    },
    onError: (err, input) => onFailed("ownOrganise", input.enabled)(err),
  });
  const setProactive = trpc.proactive.setPodDefaults.useMutation({
    onSuccess: () => {
      settled("proactive");
      void utils.proactive.getPodDefaults.invalidate();
    },
    onError: (err, input) => onFailed("proactive", input.enabled)(err),
  });
  const setLibrary = trpc.proactive.setLibraryKeepAlive.useMutation({
    onSuccess: () => {
      settled("library");
      void utils.proactive.getLibraryKeepAlive.invalidate();
    },
    onError: (err, input) => onFailed("library", input.enabled === true)(err),
  });

  const rows = defaultsStepRows(
    {
      presence: {
        read: presenceDial(presence),
        save: presenceSave(setPresence),
      },
      reversible: { read: reversible, save: setReversible },
      ownOrganise: { read: ownOrganise, save: setOwnOrganise },
      proactive: {
        read: proactiveDial(proactive),
        save: enabledSave(setProactive),
      },
      library: { read: libraryDial(library), save: enabledSave(setLibrary) },
    },
    presence
  );

  const change: Record<DefaultRow, (on: boolean) => void> = {
    presence: (on) => setPresence.mutate({ mode: on ? "enforce" : "report" }),
    reversible: (on) => setReversible.mutate({ enabled: on }),
    ownOrganise: (on) => setOwnOrganise.mutate({ enabled: on }),
    proactive: (on) => {
      if (proactive.data) {
        setProactive.mutate(proactiveInput(proactive.data, on));
      }
    },
    library: (on) => setLibrary.mutate({ enabled: on }),
  };
  const retry: Record<DefaultRow, () => void> = {
    presence: () => void presence.refetch(),
    reversible: () => void reversible.refetch(),
    ownOrganise: () => void ownOrganise.refetch(),
    proactive: () => void proactive.refetch(),
    library: () => void library.refetch(),
  };

  const onContinue = async () => {
    setPending(true);
    setRecordFailed(false);
    try {
      await recordDefaultsStep();
    } catch {
      // A failed record is shown (the alert under the switches), never
      // passed over: the step stays, with Continue to try again.
      setRecordFailed(true);
      setPending(false);
      return;
    }
    // The SERVER sends the person to the step the pod now says is next.
    window.location.assign("/start");
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-[13.5px] text-foreground/70">{t("lead")}</p>
      </div>

      <ul className="-mx-2 divide-y divide-foreground/[0.06]">
        {rows.map((view) => {
          const rowRefused = refused[view.row];
          return (
            <DefaultSwitchRow
              key={view.row}
              view={view}
              onChange={(on) => {
                settled(view.row);
                change[view.row](on);
              }}
              onRetry={retry[view.row]}
              refused={rowRefused ?? null}
              onRetryChange={() => {
                if (!rowRefused) return;
                settled(view.row);
                change[view.row](rowRefused.on);
              }}
              factors={
                view.row === "presence"
                  ? {
                      note: factorNote(factors),
                      onRetry: () => void factors.refetch(),
                    }
                  : null
              }
            />
          );
        })}
      </ul>

      {recordFailed && (
        <p role="alert" className="text-[12.5px] text-status-down">
          {t("recordFailed")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          color="primary"
          radius="md"
          isDisabled={pending}
          isLoading={pending}
          onPress={() => void onContinue()}
        >
          {t("continue")}
        </Button>
        <Button
          as={Link}
          href="/start?step=intent"
          variant="light"
          radius="md"
          isDisabled={pending}
        >
          {t("back")}
        </Button>
      </div>
    </>
  );
}

function DefaultSwitchRow({
  view,
  onChange,
  onRetry,
  refused,
  onRetryChange,
  factors,
}: {
  view: DefaultRowView;
  onChange: (on: boolean) => void;
  onRetry: () => void;
  refused: Refused | null;
  onRetryChange: () => void;
  /** The presence row's word on the person's own factors. */
  factors: { note: FactorNote; onRetry: () => void } | null;
}) {
  const t = useT(CATALOGS);
  const { row, state } = view;
  const label = t(row === "presence" ? "presence.setting" : `${row}.label`);
  const line =
    row === "presence"
      ? t("presence.line", {
          sensitive: t("presence.sensitive"),
          where: t("presence.where"),
        })
      : t(`${row}.line`);
  return (
    <li className="flex flex-col gap-1.5 px-2 py-2.5">
      <div className="flex min-h-10 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium text-foreground">
            {label}
          </span>
          <span className="block text-[12.5px] text-foreground/65">{line}</span>
          {view.lockedBy && (
            <span className="mt-0.5 block text-[12px] text-foreground/65">
              {t(
                view.lockedBy === "operator"
                  ? "locked.operator"
                  : "locked.admin"
              )}
            </span>
          )}
        </span>
        {state.kind === "failed" ? (
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-status-down">
            {t("failed")}
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
              {row === "presence"
                ? t(state.on ? "presence.on" : "presence.off")
                : t(state.on ? "on" : "off")}
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
      </div>
      {refused && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 text-[12px] text-status-down"
        >
          {t(refused.presence ? "presence.refused" : "notChanged")}{" "}
          <span className="text-foreground/65">{t("notChangedHint")}</span>
          <button
            type="button"
            className="min-h-10 font-medium text-primary underline-offset-2 hover:underline"
            onClick={onRetryChange}
          >
            {t("retry")}
          </button>
        </p>
      )}
      {factors?.note === "none" && (
        <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-foreground/65">
          {t("presence.factors.none")}
          <span aria-hidden>·</span>
          <Link
            href={PASSKEYS_PATH}
            className="inline-flex min-h-10 items-center font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("presence.factors.add")}
          </Link>
        </p>
      )}
      {factors?.note === "one" && (
        <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-foreground/65">
          {t("presence.twoWays")}
          <Link
            href={SECOND_WAY_HREF}
            className="inline-flex min-h-10 items-center font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("presence.factors.addSecond")}
          </Link>
        </p>
      )}
      {factors?.note === "failed" && (
        <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-status-down">
          {t("presence.factors.failed")}
          <button
            type="button"
            className="min-h-10 font-medium text-primary underline-offset-2 hover:underline"
            onClick={factors.onRetry}
          >
            {t("retry")}
          </button>
        </p>
      )}
    </li>
  );
}
