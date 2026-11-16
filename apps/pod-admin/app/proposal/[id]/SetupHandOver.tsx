"use client";

/**
 * WHAT IT NEEDS FROM YOU — the hand-over on a proposal that cannot apply
 * until a person gives it a key or a value (finding 91a3bfd3, plan d717d6ac
 * addendum B; founder defaults B1 server door, B2 a new key may be typed
 * here, B3 the steps per param, B5 Approve waits until it is filled).
 *
 * One row per setup row the pod says is empty (`proposals.repairOptions`
 * `setup`, `proposal-setup-model.ts`): its label, how to get it (the steps
 * and the page they start on, from the manifest's `obtain`), and the
 * hand-over itself: one of the person's saved vault keys, a NEW key typed
 * masked (the pod saves it in the vault first and keeps only its pointer),
 * or a plain value. "Hand it over" sends `proposals.repair` with `setup`; the
 * pod writes ONE revision carrying refs only and answers its number, which
 * the host approves with (`FailedApproval`) or reads again (a pending one).
 *
 * A failed read says so with a retry, never "nothing to fill". Typing a new
 * key needs a recent sign-in: the refusal says so and offers the sign-in.
 */

import { useState } from "react";
import {
  Button,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  addToast,
} from "@heroui/react";
import { ArrowUpRight, KeyRound } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { readableError } from "../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { useT } from "../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "../../_lib/request/copy";
import {
  setupEntry,
  setupRows,
  type ProposalSetupView,
  type SetupDraft,
  type SetupEntry,
  type SetupRowView,
  type SetupSecretChoiceView,
} from "./proposal-setup-model";

type Mode = "existing" | "new" | "value";

function SetupRow({
  row,
  choices,
  draft,
  onDraft,
  busy,
}: {
  row: SetupRowView;
  choices: SetupSecretChoiceView[];
  draft: SetupDraft | null;
  onDraft: (d: SetupDraft | null) => void;
  busy: boolean;
}) {
  const t = useT(REQUEST_CATALOGS);
  const mode: Mode =
    draft?.kind ??
    (row.secret ? (choices.length > 0 ? "existing" : "new") : "value");
  return (
    <li data-setup-row={row.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          {row.secret && <KeyRound aria-hidden className="h-3.5 w-3.5" />}
          {row.label}
        </span>
        {row.description && (
          <span className="text-[12px] text-foreground/60">
            {row.description}
          </span>
        )}
      </div>
      {row.obtain && (
        <div data-setup-obtain="" className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-foreground/60">
            {t("setup.steps")}
          </span>
          {row.obtain.steps.length > 0 && (
            <ol className="list-decimal pl-5 text-[12.5px] text-foreground/80">
              {row.obtain.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          {row.obtain.url && (
            <a
              href={row.obtain.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 self-start text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("setup.openPage")}
              <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
      {row.secret ? (
        <>
          {choices.length > 0 && (
            <RadioGroup
              orientation="horizontal"
              aria-label={row.label}
              value={mode}
              onValueChange={(v) =>
                onDraft(
                  v === "new"
                    ? { kind: "new", value: "" }
                    : { kind: "existing", ref: "" }
                )
              }
              isDisabled={busy}
              size="sm"
            >
              <Radio value="existing">{t("setup.pickSaved")}</Radio>
              <Radio value="new">{t("setup.typeNew")}</Radio>
            </RadioGroup>
          )}
          {mode === "existing" ? (
            <Select
              size="sm"
              aria-label={t("setup.pickSaved")}
              placeholder={t("setup.pickSaved")}
              selectedKeys={
                draft?.kind === "existing" && draft.ref ? [draft.ref] : []
              }
              onSelectionChange={(keys) => {
                const ref = [...(keys as Set<string>)][0];
                onDraft(ref ? { kind: "existing", ref } : null);
              }}
              isDisabled={busy}
            >
              {choices.map((c) => (
                <SelectItem key={c.ref} textValue={c.label}>
                  {c.label}
                  {c.service && (
                    <span className="ml-2 text-foreground/55">{c.service}</span>
                  )}
                </SelectItem>
              ))}
            </Select>
          ) : (
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              aria-label={row.label}
              placeholder={t("setup.typeNew")}
              description={t("setup.newHint")}
              value={draft?.kind === "new" ? draft.value : ""}
              onValueChange={(value) => onDraft({ kind: "new", value })}
              isDisabled={busy}
            />
          )}
        </>
      ) : (
        <Input
          size="sm"
          aria-label={row.label}
          placeholder={t("setup.typeValue")}
          value={draft?.kind === "value" ? draft.value : ""}
          onValueChange={(value) => onDraft({ kind: "value", value })}
          isDisabled={busy}
        />
      )}
    </li>
  );
}

export function SetupHandOver({
  proposalId,
  expectedRevision,
  onHandedOver,
  approving = false,
}: {
  proposalId: string;
  /** The revision the reader saw: a revise landing in between is refused. */
  expectedRevision: number;
  /** The pod wrote the revision: approve it, or read the proposal again. */
  onHandedOver: (revision: number) => void;
  /** The host is approving what was handed over. */
  approving?: boolean;
}) {
  const t = useT(REQUEST_CATALOGS);
  const utils = trpc.useUtils();
  const options = trpc.proposals.repairOptions.useQuery({ proposalId });
  const [drafts, setDrafts] = useState<Record<string, SetupDraft | null>>({});
  const [stepUp, setStepUp] = useState(false);
  const repair = trpc.proposals.repair.useMutation({
    onSuccess: (result) => {
      setDrafts({});
      addToast({ color: "success", title: t("setup.handedOver") });
      void utils.proposals.invalidate();
      onHandedOver(result.revision);
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      const reason = (err.data as { reasonCode?: unknown } | null | undefined)
        ?.reasonCode;
      setStepUp(reason === "STEP_UP_REQUIRED");
      addToast({
        color: "danger",
        title: t("setup.failed"),
        description: readableError(err.message) ?? undefined,
        timeout: Infinity,
      });
    },
  });

  if (options.isError) {
    return (
      <p
        data-setup-unreadable=""
        className="flex flex-wrap items-center gap-2 text-[12.5px] text-status-stale"
      >
        {t("setup.unreadable")}
        <Button
          size="sm"
          variant="light"
          onPress={() => void options.refetch()}
        >
          {t("setup.retry")}
        </Button>
      </p>
    );
  }
  const setup = (
    options.data as
      | {
          setup?: ProposalSetupView & {
            secretChoices?: SetupSecretChoiceView[];
          };
        }
      | undefined
  )?.setup;
  if (!setup) return null;
  const rows = setupRows(setup);
  if (rows.length === 0) return null;
  const choices = setup.secretChoices ?? [];

  const entries: Record<string, SetupEntry> = {};
  for (const row of rows) {
    const entry = setupEntry(row, drafts[row.name] ?? null);
    if (entry) entries[row.name] = entry;
  }
  const missingRequired = rows.some((r) => r.required && !entries[r.name]);
  const busy = repair.isPending || approving;

  return (
    <section
      data-setup-hand-over=""
      aria-label={t("story.needs")}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.02] p-3 ring-1 ring-inset ring-foreground/10"
    >
      <span className="text-[12px] font-medium text-foreground/65">
        {t("story.needs")}
      </span>
      <ul className="flex flex-col gap-4">
        {rows.map((row) => (
          <SetupRow
            key={row.name}
            row={row}
            choices={choices}
            draft={drafts[row.name] ?? null}
            onDraft={(d) => setDrafts((prev) => ({ ...prev, [row.name]: d }))}
            busy={busy}
          />
        ))}
      </ul>
      {stepUp && (
        <p className="text-[12.5px] text-foreground/75">
          {t("setup.signInAgain")}{" "}
          <a
            href={`/login?refresh=1&return=${encodeURIComponent(`/proposal/${proposalId}`)}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("setup.signIn")}
          </a>
        </p>
      )}
      <div>
        <Button
          color="primary"
          className="min-h-10"
          isLoading={busy}
          isDisabled={busy || missingRequired}
          onPress={() =>
            repair.mutate({
              proposalId,
              expectedRevision,
              set: {},
              // The setup arm (`setupRepairInputSchema`). Cast until the
              // generated API types carry it (backend#1071 regenerates them).
              ...({ setup: entries } as object),
            })
          }
        >
          {t("setup.handOver")}
        </Button>
      </div>
    </section>
  );
}
