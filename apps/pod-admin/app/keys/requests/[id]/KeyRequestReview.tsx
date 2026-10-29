"use client";

/**
 * The Review of a key a computer asked for (page grammar: Review), drawn with
 * the proposal review's parts (`app/_lib/review/`): the card header names
 * what approving does ("Create API key · <name>") with the status mark; who
 * asks as one line of chips; the change first ("What it asks for": the key's
 * families as marks, where, its doors, its lifetime), said ONCE; why, as one
 * mark (the template); the decision bar pinned to the bottom with the
 * consequence, "Reject…" and Approve, and who decides; Advanced last.
 *
 * "Narrow it" swaps the summary for the same family rows as New key, capped
 * by the request (`validateKeyDraft` with the ceiling, re-checked by the
 * pod): the person may narrow the key, never widen it.
 *
 * Finding da59b051: the key was said twice (a header sentence, then the same
 * sentence in a bordered review bar), the whole New key form sat in an
 * accordion inside the card, a `dl` grid stood where proposals have sections,
 * and "Deny" / "Request denied" were hand-written beside the vocabulary's
 * "Reject" / "Rejected".
 */

import { CardBody } from "@heroui/react";
import {
  Clock,
  FolderKanban,
  Hourglass,
  KeyRound,
  LayoutTemplate,
  Layers,
  Monitor,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  describeKey,
  describeKeyProblem,
  grantLifetime,
  isKeyUseId,
  keyScope,
  scopesForKey,
  validateKeyDraft,
  type KeyCeiling,
  type KeyDraft,
} from "@synap-core/types/grants";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { openIn, type Exit } from "../../../../lib/open-in";
import { ReceiverShell } from "../../../_lib/receiver-shell";
import { AdvancedPanel } from "../../../_lib/object/advanced-panel";
import { Pill } from "../../../_lib/object/provenance-chips";
import {
  DisclosedMark,
  Outcome,
  ReviewProvenance,
  ReviewSection,
} from "../../../_lib/review/review-parts";
import {
  ApproveButton,
  DECISION_BAR_PIN,
  DecisionBar,
  RejectButton,
  RejectConfirm,
  WhoDecides,
} from "../../../_lib/review/decision-bar";
import { ReviewHeader } from "../../../_lib/review/review-header";
import {
  AccessEditor,
  AccessSummary,
} from "../../../(admin)/keys/_lib/key-access";
import { NameStepBody } from "../../../(admin)/keys/_lib/key-steps";
import {
  keyRequestOutcome,
  keyRequestStatus,
} from "../../../(admin)/keys/_lib/key-form-model";

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
  // The key as the person narrowed it; until they touch it, as asked.
  const [edited, setDraft] = useState<KeyDraft | null>(null);
  const draft = edited ?? (data?.draft as KeyDraft | undefined) ?? null;
  const [narrowing, setNarrowing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctx = useMemo(
    () => ({
      kinds: (profilesQuery.data?.profiles ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || undefined,
      })),
    }),
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
      setRejecting(false);
      await utils.apiKeys.getKeyRequest.invalidate({ requestId });
    } catch (err) {
      if (
        redirectToLoginIfUnauthorized(
          err as { data?: { code?: string | null } | null } | null
        )
      )
        return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // The card's first child is always a padded section, handed over here
  // (`__tripwires__/receiver-card-body.test.ts`).
  const shell = (children: ReactNode, pinsBar = false) => (
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      width="md"
      pinsBar={pinsBar}
    >
      {children}
    </ReceiverShell>
  );

  if (request.isLoading) {
    return shell(
      <CardBody className="px-7 py-6">
        <p role="status" className="text-[13px] text-foreground/65">
          Loading the request…
        </p>
      </CardBody>
    );
  }

  if (request.isError || !data || !draft) {
    const missing = request.error?.data?.code === "NOT_FOUND";
    return shell(
      <CardBody className="gap-2 px-7 py-6">
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
            <button
              type="button"
              onClick={() => void request.refetch()}
              className="text-[13px] text-primary underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : null}
      </CardBody>
    );
  }

  const closed = data.status === "pending" ? null : data.status;
  const pending = closed === null;
  const status = keyRequestStatus(data.status);
  const asked = data.draft as KeyDraft;
  const shown = pending ? draft : asked;
  const scope = keyScope(shown.grant);
  const spaceId = shown.grant.workspaceIds?.[0] ?? null;
  const projectId = shown.grant.projectIds?.[0] ?? null;
  const spaceName = spaceId
    ? (spacesQuery.data?.find((w) => w.id === spaceId)?.name ?? null)
    : null;
  const projectName = projectId
    ? (projectsQuery.data?.items.find((p) => p.id === projectId)?.name ?? null)
    : null;
  const description = describeKey(shown, {
    kindNames: Object.fromEntries(
      ctx.kinds.flatMap((k) => (k.name ? [[k.slug, k.name]] : []))
    ),
  });
  // Full access is already the summary's one red line; the other marks say
  // what the summary cannot (delete, gate verbs, no end).
  const marks = description.marks.filter((m) => m.code !== "full-access");
  const validation = validateKeyDraft(draft, { ceiling });
  const heading = `${buildObjectActionTitle({
    action: "create",
    objectKind: "api_key",
  })} · ${shown.name}`;

  const computerExit: Exit | undefined = data.requester.isComputer
    ? {
        href: `/my-computers/${encodeURIComponent(data.requester.userId)}`,
        isDesktopLink: false,
      }
    : undefined;

  return shell(
    <>
      <ReviewHeader icon={KeyRound} heading={heading} status={status} />

      {/* Clips nothing, so the decision bar pins to the window. */}
      <CardBody className="overflow-visible px-7 pb-7 pt-5">
        <div className="flex flex-col gap-5">
          <ReviewProvenance>
            <Pill exit={computerExit}>
              <Monitor aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
              <span className="truncate font-medium text-foreground">
                {requester}
              </span>
            </Pill>
            {spaceId && spaceName ? (
              <Pill
                exit={openIn({
                  kind: "object",
                  objectKind: "workspace",
                  id: spaceId,
                })}
              >
                <Layers
                  aria-hidden
                  className="h-3.5 w-3.5 text-foreground/55"
                />
                <span className="truncate">{spaceName}</span>
              </Pill>
            ) : null}
            {projectId && projectName ? (
              <Pill
                exit={openIn({
                  kind: "object",
                  objectKind: "project",
                  id: projectId,
                })}
              >
                <FolderKanban
                  aria-hidden
                  className="h-3.5 w-3.5 text-foreground/55"
                />
                <span className="truncate">{projectName}</span>
              </Pill>
            ) : null}
            <Pill>
              <Clock aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
              <time
                dateTime={new Date(data.createdAt).toISOString()}
                title={formatTimestamp(data.createdAt)}
              >
                {formatRelative(data.createdAt)}
              </time>
            </Pill>
            {pending ? (
              <Pill title="The request waits for you until then">
                <Hourglass
                  aria-hidden
                  className="h-3.5 w-3.5 text-foreground/55"
                />
                <span>ends {formatRelative(data.expiresAt)}</span>
              </Pill>
            ) : null}
          </ReviewProvenance>

          {/* The change first, said once. */}
          <ReviewSection label="What it asks for">
            {pending && narrowing ? (
              <>
                <AccessEditor
                  draft={draft}
                  scope={scope}
                  ctx={ctx}
                  ceiling={ceiling}
                  onChange={setDraft}
                />
                <NameStepBody draft={draft} onChange={setDraft} />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setNarrowing(false)}
                    className="text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <AccessSummary draft={shown} scope={scope} ctx={ctx} />
                {marks.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {marks.map((m) => (
                      <span
                        key={m.code}
                        className={`inline-flex h-6 items-center rounded-full px-2 text-[11.5px] font-medium ring-1 ring-inset ${
                          m.code === "never-expires"
                            ? "bg-warning/10 text-warning ring-warning/25"
                            : "bg-danger/10 text-danger ring-danger/25"
                        }`}
                      >
                        {m.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {pending ? (
                  <button
                    type="button"
                    onClick={() => setNarrowing(true)}
                    className="self-start text-[12.5px] text-foreground/70 underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
                  >
                    Narrow it
                  </button>
                ) : null}
              </>
            )}
          </ReviewSection>

          {/* Why: ONE mark, the template's sentence on press. */}
          <section
            aria-label="Why"
            className="flex flex-wrap items-center gap-2"
          >
            <DisclosedMark
              icon={LayoutTemplate}
              mark={
                data.template
                  ? {
                      tone: "default",
                      label: data.template.name,
                      sentence: data.template.description,
                    }
                  : {
                      tone: "warning",
                      label: "Template gone",
                      sentence:
                        "The template it named no longer exists; the key is what it asked for.",
                    }
              }
            />
          </section>

          <DecisionBar pinned={pending} className={DECISION_BAR_PIN}>
            {pending ? (
              <>
                <p className="text-[12.5px] text-foreground/75">
                  {requester} receives the key once, the next time it checks. It
                  acts as you, within what it asks for here, until{" "}
                  {grantLifetime(draft.grant).kind === "never"
                    ? "you revoke it"
                    : "it expires or you revoke it"}
                  .
                </p>
                {!validation.ok ? (
                  <ul className="flex flex-col gap-0.5">
                    {validation.problems.map((p, i) => (
                      <li key={i} className="text-[12px] text-foreground/75">
                        {describeKeyProblem(p).text}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {error ? (
                  <p role="alert" className="text-[12px] text-danger">
                    {error}
                  </p>
                ) : null}
                {rejecting ? (
                  <RejectConfirm
                    isLoading={busy === "deny"}
                    onConfirm={() => void send("deny")}
                    onCancel={() => setRejecting(false)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <ApproveButton
                      isLoading={busy === "approve"}
                      isDisabled={!validation.ok || busy !== null}
                      onPress={() => void send("approve")}
                    />
                    <RejectButton
                      isDisabled={busy !== null}
                      onPress={() => setRejecting(true)}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <Outcome
                  status={status}
                  message={keyRequestOutcome(closed!, requester)}
                />
                {data.status === "approved" || data.status === "consumed" ? (
                  <a
                    href="/my-connections"
                    className="text-[13px] text-primary underline-offset-2 hover:underline"
                  >
                    See your keys
                  </a>
                ) : null}
              </>
            )}
            <WhoDecides identity={identity} />
          </DecisionBar>

          <AdvancedPanel
            ids={[
              { label: "Request id", value: data.requestId },
              ...(data.template
                ? [{ label: "Template", value: data.template.id }]
                : []),
              {
                label: "Scopes it gets",
                value: scopesForKey({
                  uses: shown.uses,
                  permissions: shown.grant.permissions,
                }).join(", "),
              },
              {
                label: "Permissions",
                value: shown.grant.permissions.join(", "),
              },
            ]}
          />
        </div>
      </CardBody>
    </>,
    pending
  );
}
