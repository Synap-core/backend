"use client";

/**
 * WHAT IT NEEDS FROM YOU — the hand-over on a proposal that cannot apply
 * until a person gives it a key or a value, or makes a connection (finding
 * 91a3bfd3, plan d717d6ac addendum B; founder defaults B1 server door, B2 a
 * new key may be typed here, B3 the steps per param, B5 Approve waits until
 * it is filled).
 *
 * One row per setup row the pod says is empty (`proposals.repairOptions`
 * `setup`, `proposal-setup-model.ts`): its label, how to get it (the steps
 * and the page they start on, from the manifest's `obtain`), and the
 * hand-over itself: one of the person's saved vault keys, a NEW key typed
 * masked (the pod saves it in the vault first and keeps only its pointer),
 * or a plain value. A required connection says the pod's own next step.
 * "Hand it over" sends `proposals.repair` with `setup`; the pod writes ONE
 * revision carrying refs only and answers its number, which the host
 * approves with (`FailedApproval`) or reads again (a pending one).
 *
 * While it reads, it says so; a failed read says so with a retry, never
 * "nothing to fill". A setup the pod cannot read is said once, beside the
 * verbs it holds (the decision bar), not here too. Typing a new key needs a
 * recent sign-in: the refusal says so and offers the sign-in, back here.
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
import type {
  SetupRepairEntry,
  SetupSecretChoice,
} from "../../_lib/request/api";
import {
  proposalSetupBlock,
  setupEntry,
  setupRows,
  type SetupRowView,
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
  choices: SetupSecretChoice[];
  draft: SetupRepairEntry | null;
  onDraft: (d: SetupRepairEntry | null) => void;
  busy: boolean;
}) {
  const t = useT(REQUEST_CATALOGS);
  const mode: Mode =
    draft?.kind ??
    (row.secret ? (choices.length > 0 ? "existing" : "new") : "value");
  return (
    <li data-setup-row={row.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
          {row.secret && <KeyRound aria-hidden className="h-3.5 w-3.5" />}
          {row.label}
        </span>
        {row.description && (
          <span className="text-[12.5px] text-foreground/75">
            {row.description}
          </span>
        )}
      </div>
      {row.obtain && (
        <div data-setup-obtain="" className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-foreground/75">
            {t("setup.steps")}
          </span>
          {row.obtain.steps.length > 0 && (
            <ol className="list-decimal pl-5 text-[13px] text-foreground/85">
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
              className="rq-ink inline-flex items-center gap-1 self-start text-[13px] font-medium underline underline-offset-2"
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
            >
              <Radio value="existing">{t("setup.pickSaved")}</Radio>
              <Radio value="new">{t("setup.typeNew")}</Radio>
            </RadioGroup>
          )}
          {mode === "existing" ? (
            <Select
              aria-label={t("setup.pickSaved")}
              placeholder={t("setup.pickPlaceholder")}
              selectedKeys={
                draft?.kind === "existing" && draft.ref ? [draft.ref] : []
              }
              onSelectionChange={(keys) => {
                const ref = [...(keys as Set<string>)][0];
                onDraft(ref ? { kind: "existing", ref } : null);
              }}
              isDisabled={busy}
              classNames={{ trigger: "min-h-11" }}
            >
              {choices.map((c) => (
                <SelectItem key={c.ref} textValue={c.label}>
                  {c.label}
                  {c.service && (
                    <span className="ml-2 text-foreground/70">{c.service}</span>
                  )}
                </SelectItem>
              ))}
            </Select>
          ) : (
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={row.label}
              placeholder={t("setup.typeNew")}
              description={t("setup.newHint")}
              value={draft?.kind === "new" ? String(draft.value) : ""}
              onValueChange={(value) => onDraft({ kind: "new", value })}
              isDisabled={busy}
              classNames={{ inputWrapper: "min-h-11" }}
            />
          )}
        </>
      ) : (
        <Input
          aria-label={row.label}
          placeholder={t("setup.typeValue")}
          value={draft?.kind === "value" ? String(draft.value) : ""}
          onValueChange={(value) => onDraft({ kind: "value", value })}
          isDisabled={busy}
          classNames={{ inputWrapper: "min-h-11" }}
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
  const [drafts, setDrafts] = useState<Record<string, SetupRepairEntry | null>>(
    {}
  );
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
          className="min-h-11"
          onPress={() => void options.refetch()}
        >
          {t("setup.retry")}
        </Button>
      </p>
    );
  }
  if (options.isLoading) {
    // A skeleton in the row's shape (UX S13a): the bar's "Fill in … first"
    // then points at a place on the page, not at nothing.
    return (
      <section
        data-setup-loading=""
        aria-busy="true"
        className="flex flex-col gap-2"
      >
        <span className="text-[13px] font-medium text-foreground/80">
          {t("story.needs")}
        </span>
        <span className="h-4 w-40 animate-pulse rounded bg-foreground/[0.08]" />
        <span className="h-11 w-full max-w-sm animate-pulse rounded-lg bg-foreground/[0.08]" />
        <span className="sr-only">{t("setup.loading")}</span>
      </section>
    );
  }
  const setup = options.data?.setup;
  if (!setup) return null;
  const block = proposalSetupBlock(setup);
  const rows = setupRows(setup);
  if (block?.kind === "unreadable") return null;
  if (rows.length === 0 && block?.kind !== "connect") return null;
  const choices = setup.secretChoices;

  const entries: Record<string, SetupRepairEntry> = {};
  for (const row of rows) {
    const entry = setupEntry(row, drafts[row.name] ?? null);
    if (entry) entries[row.name] = entry;
  }
  const missingRequired = rows.some((r) => r.required && !entries[r.name]);
  const nothingToSend = Object.keys(entries).length === 0;
  const busy = repair.isPending || approving;
  const here =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}`
      : `/proposal/${proposalId}`;

  return (
    <section
      data-setup-hand-over=""
      aria-label={t("story.needs")}
      className="flex flex-col gap-4"
    >
      <span className="text-[13px] font-medium text-foreground/80">
        {t("story.needs")}
      </span>
      {block?.kind === "connect" && (
        <p
          data-setup-connect=""
          className="flex flex-wrap items-center gap-2 text-[13.5px]"
        >
          {block.hint}
          {block.url && (
            <a
              href={block.url}
              className="rq-ink inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              {t("setup.connectOpen")}
              <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
        </p>
      )}
      {rows.length > 0 && (
        <>
          <ul className="flex flex-col gap-5">
            {rows.map((row) => (
              <SetupRow
                key={row.name}
                row={row}
                choices={choices}
                draft={drafts[row.name] ?? null}
                onDraft={(d) =>
                  setDrafts((prev) => ({ ...prev, [row.name]: d }))
                }
                busy={busy}
              />
            ))}
          </ul>
          {stepUp && (
            <p className="text-[13px] text-foreground/80">
              {t("setup.signInAgain")}{" "}
              <a
                href={`/login?refresh=1&return=${encodeURIComponent(here)}`}
                className="rq-ink font-medium underline underline-offset-2"
              >
                {t("setup.signIn")}
              </a>
            </p>
          )}
          <div>
            <Button
              color="primary"
              className="min-h-11"
              isLoading={busy}
              isDisabled={busy || missingRequired || nothingToSend}
              onPress={() =>
                repair.mutate({
                  proposalId,
                  expectedRevision,
                  set: {},
                  setup: entries,
                })
              }
            >
              {t("setup.handOver")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
