"use client";

/**
 * Tools › Skills — every skill the reader can see: the ones waiting to be
 * turned on first, then the ones on. Shaping and the turn-on rule live in
 * `skills-model.ts`.
 *
 * Two reads of `skills.list` (user-floored): `approved: false` and
 * `approved: true`, each up to the door's 100. An instruction skill waiting is
 * turned on here, after its instructions are read whole in the confirmation
 * (`skills.setApproved`; the pod re-checks the owner or pod-admin gate and its
 * refusal is shown in the dialog). Any other skill waiting opens in the app.
 */

import { addToast, Button } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import {
  humanizeToken,
  resolveActionLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { readableError, formatRelative } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { ProposedRecordCard } from "../../../proposal/[id]/ProposedRecordCard";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import {
  SKILLS_ON_SHOWN,
  skillLists,
  type SkillListRow,
  type SkillRow,
} from "./skills-model";

const SkillIcon = kindIcon("skill");
const READ = { staleTime: 30_000, retry: false } as const;
const TURN_ON = resolveActionLabel("turn_on");

export function SkillsTab() {
  const utils = trpc.useUtils();
  const waitingRead = trpc.skills.list.useQuery(
    { approved: false, limit: 100 },
    READ
  );
  const onRead = trpc.skills.list.useQuery(
    { approved: true, limit: 100 },
    READ
  );
  const spaces = trpc.workspaces.list.useQuery(undefined, READ);
  const [all, setAll] = useState(false);
  const [pending, setPending] = useState<SkillRow | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const err = waitingRead.error ?? onRead.error;
    if (err) redirectToLoginIfUnauthorized(err);
  }, [waitingRead.error, onRead.error]);

  const lists = useMemo(
    () =>
      skillLists(
        (waitingRead.data?.skills ?? []) as SkillListRow[],
        (onRead.data?.skills ?? []) as SkillListRow[]
      ),
    [waitingRead.data, onRead.data]
  );

  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) =>
      id ? (byId.get(id) ?? "A space") : "Whole pod";
  }, [spaces.data]);
  const secondary = (row: SkillRow): string =>
    [
      humanizeToken(row.kind),
      row.slug,
      spaceName(row.workspaceId),
      `added ${formatRelative(row.createdAt, { empty: "" })}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const setApproved = trpc.skills.setApproved.useMutation({
    onSuccess: async () => {
      const name = pending?.name ?? "the skill";
      setPending(null);
      setRefusal(null);
      addToast({
        title: `${resolveActionLabel("turn_on", "past")} “${name}”`,
        color: "default",
      });
      await utils.skills.list.invalidate();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      // The pod's own words: who may turn it on is its call, not this page's.
      setRefusal(readableError(err.message) ?? "The pod didn’t turn it on.");
    },
  });

  const on = all ? lists.on : lists.on.slice(0, SKILLS_ON_SHOWN);

  return (
    <div className="flex flex-col gap-4">
      {(waitingRead.isError || lists.waiting.length > 0) && (
        <SectionCard
          title="Waiting to be turned on"
          hint="Nothing loads or runs them until they are on"
        >
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {waitingRead.isError ? (
              <ResourceRowError
                message="Couldn't read the skills waiting to be turned on."
                onRetry={() => void waitingRead.refetch()}
              />
            ) : (
              lists.waiting.map((row) => (
                <ResourceRow
                  key={row.id}
                  Icon={SkillIcon}
                  primary={row.name}
                  secondary={secondary(row)}
                  wrap
                  actions={
                    row.turnOn === "here" ? (
                      <Button
                        size="sm"
                        variant="flat"
                        radius="md"
                        onPress={() => {
                          setRefusal(null);
                          setPending(row);
                        }}
                      >
                        Read and turn on
                      </Button>
                    ) : (
                      <ExitLink
                        exit={openIn({
                          kind: "objectInApp",
                          objectKind: "skill",
                          id: row.id,
                        })}
                        label={`${TURN_ON} in app`}
                      />
                    )
                  }
                />
              ))
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="On"
        hint={
          onRead.isSuccess
            ? `${lists.on.length}${onRead.data.skills.length === 100 ? "+" : ""} on`
            : undefined
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {onRead.isLoading ? (
            <ResourceRowSkeleton count={4} />
          ) : onRead.isError ? (
            <ResourceRowError
              message="Couldn't read the skills that are on."
              onRetry={() => void onRead.refetch()}
            />
          ) : on.length === 0 ? (
            <ResourceRowEmpty message="No skill is on yet." />
          ) : (
            on.map((row) => (
              <ResourceRow
                key={row.id}
                Icon={SkillIcon}
                primary={row.name}
                secondary={secondary(row)}
                wrap
              />
            ))
          )}
        </div>
        {!all && lists.on.length > SKILLS_ON_SHOWN && (
          <Button
            size="sm"
            variant="light"
            radius="md"
            className="mt-2 self-start"
            onPress={() => setAll(true)}
          >
            Show all {lists.on.length}
          </Button>
        )}
      </SectionCard>

      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => {
          setPending(null);
          setRefusal(null);
        }}
        onConfirm={() =>
          pending && setApproved.mutate({ id: pending.id, approved: true })
        }
        title={`${TURN_ON} “${pending?.name ?? ""}”?`}
        consequence={
          <>
            From now on agents load these instructions when the skill applies.
            It runs nothing on its own. You can turn it off in the app.
          </>
        }
        confirmLabel={TURN_ON}
        confirmColor="warning"
        isPending={setApproved.isPending}
      >
        <div className="max-h-[50vh] overflow-y-auto">
          {pending?.record && <ProposedRecordCard record={pending.record} />}
          {pending?.bodyDocumentId && (
            <ExitLink
              exit={openIn({
                kind: "object",
                objectKind: "document",
                id: pending.bodyDocumentId,
              })}
              label="Read its instructions"
            />
          )}
        </div>
        {refusal && <p className="text-[12.5px] text-status-down">{refusal}</p>}
      </ConfirmModal>
    </div>
  );
}
