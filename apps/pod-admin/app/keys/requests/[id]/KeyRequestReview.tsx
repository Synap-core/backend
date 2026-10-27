"use client";

/**
 * The Review of a key a computer asked for (page grammar: Review). Who asks,
 * the change first (the key in words, its marks), why (the template, the
 * command), what approving does; then the same sections as New key, locked
 * to the request: the person may narrow the key, never widen it
 * (`validateKeyDraft` with the request's ceiling, re-checked by the pod).
 * One primary, Create key; Deny beside it.
 */

import { Accordion, AccordionItem, Button, Chip } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import {
  describeKey,
  grantLifetime,
  isKeyUseId,
  validateKeyDraft,
  type KeyCeiling,
  type KeyDraft,
} from "@synap-core/types/grants";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import { ReceiverShell } from "../../../_lib/receiver-shell";
import {
  KeyReviewBar,
  KeySections,
  type KeyPlace,
} from "../../../(admin)/keys/_lib/key-sections";
import { keyRequestOutcome } from "../../../(admin)/keys/_lib/key-form-model";

export function KeyRequestReview({
  requestId,
  podHost,
  identity,
}: {
  requestId: string;
  podHost?: string;
  identity?: string;
}) {
  const request = trpc.apiKeys.getKeyRequest.useQuery(
    { requestId },
    { retry: false }
  );
  const spacesQuery = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const projectsQuery = trpc.projects.list.useQuery(
    { limit: 200 },
    { staleTime: 60_000 }
  );
  const profilesQuery = trpc.profiles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const utils = trpc.useUtils();
  const decide = trpc.apiKeys.decideKeyRequest.useMutation();

  useEffect(() => {
    if (request.error) redirectToLoginIfUnauthorized(request.error);
  }, [request.error]);

  const data = request.data;
  const ceiling = useMemo<KeyCeiling | undefined>(
    () =>
      data ? { grant: data.draft.grant, uses: data.draft.uses } : undefined,
    [data]
  );
  const [draft, setDraft] = useState<KeyDraft | null>(null);
  useEffect(() => {
    if (data && !draft) setDraft(data.draft as KeyDraft);
  }, [data, draft]);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spaces = useMemo<KeyPlace[]>(() => {
    const all = (spacesQuery.data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
    }));
    // Under a request pinned to spaces, only those can be ticked.
    const pinned = ceiling?.grant.workspaceIds;
    return pinned?.length ? all.filter((s) => pinned.includes(s.id)) : all;
  }, [spacesQuery.data, ceiling]);
  const projects = useMemo<KeyPlace[]>(
    () =>
      (projectsQuery.data?.items ?? []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [projectsQuery.data]
  );

  const kinds = useMemo(
    () =>
      (profilesQuery.data ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || p.slug,
      })),
    [profilesQuery.data]
  );

  const requester = data?.requester.name.trim() || "Your computer";

  async function send(decision: "approve" | "deny") {
    if (!draft) return;
    setBusy(decision);
    setError(null);
    try {
      await decide.mutateAsync(
        decision === "deny"
          ? { requestId, decision }
          : {
              requestId,
              decision,
              draft: {
                name: draft.name,
                ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
                templateId: draft.templateId ?? null,
                uses: draft.uses.filter(isKeyUseId),
                grant: {
                  permissions: [...draft.grant.permissions],
                  ...(draft.grant.workspaceIds?.length
                    ? { workspaceIds: [...draft.grant.workspaceIds] }
                    : {}),
                  ...(draft.grant.projectIds?.length
                    ? { projectIds: [...draft.grant.projectIds] }
                    : {}),
                  ...(draft.grant.entityIds?.length
                    ? { entityIds: [...draft.grant.entityIds] }
                    : {}),
                  expiresInDays: draft.grant.expiresInDays,
                },
              },
            }
      );
      await utils.apiKeys.getKeyRequest.invalidate({ requestId });
    } catch (err) {
      if (redirectToLoginIfUnauthorized(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (request.isLoading || (data && !draft)) {
    return (
      <ReceiverShell podHost={podHost} identity={identity} width="sm">
        <p role="status" className="text-[13px] text-foreground/65">
          Loading the request…
        </p>
      </ReceiverShell>
    );
  }

  if (request.isError || !data || !draft) {
    const missing = request.error?.data?.code === "NOT_FOUND";
    return (
      <ReceiverShell podHost={podHost} identity={identity} width="sm">
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-[18px] font-medium">
            {missing ? "No such request" : "Couldn't load this request"}
          </h1>
          <p className="text-[13px] text-foreground/70">
            {missing
              ? "It may be another person's, or the link is wrong. Run the command again to get a new link."
              : (request.error?.message ?? "Something went wrong.")}
          </p>
          {!missing ? (
            <div>
              <Button
                size="sm"
                variant="flat"
                onPress={() => void request.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </ReceiverShell>
    );
  }

  const requested = (
    <span>
      {requester}
      {data.requester.isComputer ? " (a computer)" : ""} asked{" "}
      {formatRelative(data.createdAt)}
    </span>
  );

  if (data.status !== "pending") {
    const out = keyRequestOutcome(data.status, requester);
    return (
      <ReceiverShell
        podHost={podHost}
        identity={identity}
        requested={requested}
        width="sm"
      >
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-[18px] font-medium">{out.title}</h1>
          <p className="text-[13px] text-foreground/70">{out.body}</p>
        </div>
      </ReceiverShell>
    );
  }

  const asked = describeKey(data.draft as KeyDraft);
  const validation = validateKeyDraft(draft, { ceiling });

  return (
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      requested={requested}
      width="md"
      pinsBar
    >
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="font-heading text-[18px] font-medium">
            {requester} asks for a key
          </h1>
          <p
            className={`text-[13px] ${asked.summary.full ? "text-danger" : "text-foreground/80"}`}
          >
            {asked.sentence}
          </p>
          {asked.marks.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {asked.marks.map((m) => (
                <Chip
                  key={m.code}
                  size="sm"
                  variant="flat"
                  color={m.code === "never-expires" ? "warning" : "danger"}
                >
                  {m.label}
                </Chip>
              ))}
            </div>
          ) : null}
        </header>

        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-foreground/60">Why</dt>
          <dd>
            {data.template ? (
              <>
                <span className="font-medium">{data.template.name}</span>:{" "}
                {data.template.description}
              </>
            ) : (
              "A template that no longer exists; the key is what it asked for."
            )}
          </dd>
          <dt className="text-foreground/60">If you approve</dt>
          <dd>
            {requester} receives the key once, the next time it checks. It acts
            as you, within what you set below, until{" "}
            {grantLifetime(draft.grant).kind === "never"
              ? "you revoke it"
              : "it expires or you revoke it"}
            .
          </dd>
          <dt className="text-foreground/60">Request ends</dt>
          <dd>{formatRelative(data.expiresAt)}</dd>
        </dl>

        <Accordion variant="splitted" className="px-0">
          <AccordionItem
            key="narrow"
            aria-label="Narrow it"
            title={<span className="text-[13px] font-medium">Narrow it</span>}
            subtitle={
              <span className="text-[12px] text-foreground/60">
                You can take things away, never add past what was asked.
              </span>
            }
          >
            <KeySections
              draft={draft}
              onChange={setDraft}
              kinds={kinds}
              spaces={spaces}
              projects={projects}
              placesFailed={
                spacesQuery.isError || projectsQuery.isError
                  ? {
                      retry: () => {
                        void spacesQuery.refetch();
                        void projectsQuery.refetch();
                      },
                    }
                  : null
              }
              ceiling={ceiling}
            />
          </AccordionItem>
        </Accordion>

        <KeyReviewBar
          draft={draft}
          validation={validation}
          primaryLabel={buildObjectActionTitle({
            action: "create",
            objectKind: "api_key",
          })}
          onPrimary={() => void send("approve")}
          busy={busy === "approve"}
          error={error}
          secondary={
            <Button
              size="sm"
              radius="md"
              variant="flat"
              color="danger"
              isLoading={busy === "deny"}
              isDisabled={busy !== null}
              onPress={() => void send("deny")}
            >
              Deny
            </Button>
          }
        />
      </div>
    </ReceiverShell>
  );
}
