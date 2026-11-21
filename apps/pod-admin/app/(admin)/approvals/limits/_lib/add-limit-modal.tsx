"use client";

/**
 * Add a daily write limit: who (every agent, or one agent), where (the whole
 * pod, or one space), and a whole number of writes per day. The door is
 * `governanceCeilings.create`; the pod checks who may (pod admin for the whole
 * pod, an editor of the space, the agent's owner) and its refusal is shown as
 * it said it.
 */

import {
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  addToast,
} from "@heroui/react";
import { useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { readableError } from "../../../../../lib/format";
import { useT } from "../../../../../lib/i18n/locale-provider";
import {
  EMPTY_LIMIT_DRAFT,
  createLimitInput,
  parseLimitValue,
  type LimitDraft,
} from "../../../../../lib/governance-ceilings/limits-model";
import { FormModal } from "../../../components/form-modal";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

interface Named {
  id: string;
  name?: string | null;
}

export function AddLimitModal({
  agents,
  spaces,
  onClose,
}: {
  agents: { data?: readonly Named[]; isError: boolean; isLoading: boolean };
  spaces: readonly Named[];
  onClose: () => void;
}) {
  const t = useT(CATALOGS);
  const [draft, setDraft] = useState<LimitDraft>(EMPTY_LIMIT_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const create = trpc.governanceCeilings.create.useMutation();
  const input = createLimitInput(draft);
  const valueInvalid =
    draft.value.trim() !== "" && parseLimitValue(draft.value) === null;
  const set = (patch: Partial<LimitDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));

  async function submit() {
    if (!input) return;
    setError(null);
    try {
      await create.mutateAsync(input);
      await utils.governanceCeilings.list.invalidate();
      addToast({
        title: t("form.done", { count: input.limitValue }),
        color: "success",
      });
      onClose();
    } catch (err) {
      setError(
        readableError(err instanceof Error ? err.message : null) ??
          t("form.failed")
      );
    }
  }

  return (
    <FormModal
      title={t("form.title")}
      submitLabel={t("form.submit")}
      isPending={create.isPending}
      canSubmit={input !== null}
      error={error}
      onSubmit={() => void submit()}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
    >
      <RadioGroup
        label={t("form.who")}
        size="sm"
        orientation="horizontal"
        value={draft.who}
        onValueChange={(v) =>
          set({ who: v === "agent" ? "agent" : "any", agentUserId: null })
        }
      >
        <Radio value="any">{t("form.whoAny")}</Radio>
        <Radio value="agent">{t("form.whoAgent")}</Radio>
      </RadioGroup>
      {draft.who === "agent" &&
        (agents.isError ? (
          <p role="alert" className="text-[12.5px] text-status-down">
            {t("form.agentsFailed")}
          </p>
        ) : (
          <Select
            size="sm"
            radius="md"
            variant="bordered"
            label={t("form.agent")}
            isLoading={agents.isLoading}
            selectedKeys={draft.agentUserId ? [draft.agentUserId] : []}
            onSelectionChange={(keys) =>
              set({
                agentUserId: Array.from(keys as Set<string>)[0] ?? null,
              })
            }
          >
            {(agents.data ?? []).map((a) => (
              <SelectItem key={a.id}>{a.name || t("form.agent")}</SelectItem>
            ))}
          </Select>
        ))}

      <RadioGroup
        label={t("form.where")}
        size="sm"
        orientation="horizontal"
        value={draft.where}
        onValueChange={(v) =>
          set({ where: v === "space" ? "space" : "pod", workspaceId: null })
        }
      >
        <Radio value="pod">{t("form.wherePod")}</Radio>
        <Radio value="space">{t("form.whereSpace")}</Radio>
      </RadioGroup>
      {draft.where === "space" && (
        <Select
          size="sm"
          radius="md"
          variant="bordered"
          label={t("form.space")}
          selectedKeys={draft.workspaceId ? [draft.workspaceId] : []}
          onSelectionChange={(keys) =>
            set({ workspaceId: Array.from(keys as Set<string>)[0] ?? null })
          }
        >
          {spaces.map((s) => (
            <SelectItem key={s.id}>{s.name || t("form.space")}</SelectItem>
          ))}
        </Select>
      )}

      <Input
        type="number"
        size="sm"
        radius="md"
        variant="bordered"
        label={t("form.value")}
        className="max-w-48"
        min={1}
        step={1}
        inputMode="numeric"
        value={draft.value}
        onValueChange={(v) => set({ value: v })}
        isInvalid={valueInvalid}
        errorMessage={t("form.valueHint")}
        description={t("form.valueHint")}
      />
    </FormModal>
  );
}
