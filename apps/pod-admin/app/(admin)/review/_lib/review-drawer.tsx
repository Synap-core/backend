"use client";

/**
 * Review's detail — one decision, read before it is made. Docked beside the
 * list from `lg` up (`ReviewDock`, non-modal: the list stays usable), a
 * drawer below it (`ReviewDrawer`); both draw the same `ReviewDetail`.
 *
 * A proposal is drawn WHOLE by `ProposalReviewBody`, the component its
 * receiver page `/proposal/[id]` draws: provenance as one line of chips, the
 * change, why, the decision bar and the ONE "Advanced" — this file adds only
 * the frame. The other kinds open on the five TRUST SIGNALS (who is asking,
 * what it will be able to do, where, who approves, when and from where) and
 * the policy's "why this needs approval", then decide through the SAME UI
 * their own receiver page uses — never a copy:
 *
 *   proposal       → `ProposalReviewBody` (+ "always approve"), `/proposal/[id]`
 *   agent connect  → `AgentConnectDecision` (keeps "also disconnect" — the
 *                    REST door is the only one that takes it), `/approve-agent`
 *   issuer         → `IssuerScopePicker`, the issuers list's approve modal
 *   app request    → `useConnectionRequest` + `ConnectionRequestDetails`,
 *                    `/connection-requests/[id]` — without its return-to-app
 *                    redirect: here a decision only closes the drawer.
 *   agent's ask    → `AskAnswer` (`ask-answer.tsx`): not a grant, so not the
 *                    trust signals — who asks, what it looked at, and the
 *                    answer control for its mode.
 *
 * The approve / reject buttons this file owns stay pinned to the bottom of
 * the scrolling detail (`DecisionBar`). Ids and raw requests sit under
 * "Advanced", collapsed, last.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Spinner, Textarea, addToast } from "@heroui/react";
import { Check, Info, X } from "lucide-react";
import { AdvancedPanel } from "../../../_lib/object/advanced-panel";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { trpc } from "../../../../lib/trpc";
import {
  buildObjectActionTitle,
  resolveActionLabel,
} from "@synap-core/types/vocabulary";
import { useApproveIssuer } from "../../../_lib/presence/use-request-doors";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { DetailDrawer } from "../../components/detail-drawer";
import { proposalRequester } from "@synap-core/types/proposals";
import { proposalPageT } from "../../../proposal/[id]/copy";
import { requestReadFailure } from "../../../proposal/[id]/request-read-failure";
import { RequestUnreadable } from "../../../proposal/[id]/RequestUnreadable";
import {
  ProposalReviewBody,
  isActionable,
  useProposalReview,
  type ProposalReviewData,
} from "../../../proposal/[id]/ProposalReviewCard";
import {
  AgentConnectDecision,
  useAgentConnect,
} from "../../../approve-agent/[keyId]/AgentConnectDecision";
import {
  ConnectionRequestDetails,
  UnverifiedAccountNotice,
  matchesApprovedConnection,
  useAccountLinkGate,
  requestExpiry,
  useConnectionRequest,
} from "../../../connection-requests/[requestId]/ConnectionRequestDecision";
import {
  DEFAULT_ISSUER_SCOPES,
  IssuerScopePicker,
  type TrustedIssuerScope,
} from "./issuer-review";
import { AskAnswer } from "./ask-answer";
import type { LensRow } from "@synap-core/types/lens";
import { requestStory, type RequestStory } from "@synap-core/types/needs-you";
import type { StoryRead } from "../../../_lib/request/request-story-view";
import type { RequestContext } from "../../../_lib/request/use-request-context";
import { RequestKindTile } from "../../../_lib/request/request-row-lines";
import type { RequestFamily } from "../../../_lib/request/family";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "../../../_lib/request/copy";
import { DRAWER_CATALOGS, NAME_MARK, drawerT } from "./drawer-copy";
import type { AskSlot } from "./ask-detail";
import type { ReviewDetail } from "./review-rows";

/** Where the viewer is and who they are — the anti-phishing half of a decision. */
export interface ReviewViewer {
  podHost?: string;
  identity?: string;
}

type DrawerDetail = Exclude<ReviewDetail, { kind: "open" }>;

export interface OpenReview {
  detail: DrawerDetail;
  /** The decision's title; for an ask, the question (`askCardView`). */
  title: string;
  /**
   * The row's shared lens row, when a Review row opened it: what its story
   * (`requestStory`) is told from. Absent for a `?focus=` on a request no
   * longer waiting: the review then reads its own (a proposal) or none.
   */
  lens?: LensRow;
  /** The request's family: its kind tile beside the title (the row's own). */
  family?: RequestFamily;
  /** The tile's accessible name (the row's kind noun). */
  noun?: string;
  /**
   * One sentence under the title: what it is for (the ask's why). When it
   * is drawn, the ask does not draw its why again (`showContext`).
   */
  sentence?: string | null;
}

/** The page's request context read (`useRequestContext`), shared by every open request. */
export type ReviewStoryContext = Pick<
  RequestContext,
  "context" | "read" | "refetch" | "updatedAt"
>;

interface ReviewFrameProps {
  open: OpenReview | null;
  viewer: ReviewViewer;
  onClose: () => void;
  /** An open ask's question as the pod holds it NOW (null = moved on). */
  liveAsk: AskSlot | null;
  /** An open ask was answered, done or handed back. */
  onAskSettled: () => void;
  /** The page's context read; absent where no page read it (a test, a host). */
  storyContext?: ReviewStoryContext;
}

export type DetailProps = Omit<ReviewFrameProps, "open"> & { open: OpenReview };

/** Below `lg`: the decision in a modal drawer over the list. */
export function ReviewDrawer({ open, ...rest }: ReviewFrameProps) {
  const rt = useT(REQUEST_CATALOGS);
  return (
    <DetailDrawer
      isOpen={open !== null}
      onClose={rest.onClose}
      title={open?.title ?? rt("detail.fallbackTitle")}
      // The ONE head the dock draws too: the kind tile, the title, what it
      // is for (code review M2).
      header={
        open ? (
          <RequestHeader
            family={open.family}
            noun={open.noun}
            title={open.title}
            sentence={open.sentence ?? null}
          />
        ) : undefined
      }
      size="lg"
    >
      {open && <ReviewDetail open={open} {...rest} />}
    </DetailDrawer>
  );
}

/**
 * From `lg` up: the decision docked beside the list, sticky while the page
 * scrolls. Its body scrolls on its own, padded like the drawer's so the
 * pinned decision bar sits the same in both.
 */
export function ReviewDock({ open, ...rest }: ReviewFrameProps) {
  if (!open) return null;
  const { onClose } = rest;
  return (
    <DockFrame open={open} onClose={onClose}>
      <ReviewDetail open={open} {...rest} />
    </DockFrame>
  );
}

function DockFrame({
  open,
  onClose,
  children,
}: {
  open: OpenReview;
  onClose: () => void;
  children: ReactNode;
}) {
  const rt = useT(REQUEST_CATALOGS);
  return (
    <aside
      aria-label={open.title}
      className="sticky top-4 flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col overflow-hidden rounded-xl bg-content1 ring-1 ring-inset ring-foreground/10"
    >
      <div className="flex items-start gap-3 px-6 pb-2 pt-6">
        <RequestHeader
          family={open.family}
          noun={open.noun}
          title={open.title}
          sentence={open.sentence ?? null}
        />
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          onPress={onClose}
          aria-label={rt("detail.close")}
          className="min-h-11 min-w-11 shrink-0 text-foreground/70 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
    </aside>
  );
}

/**
 * The detail's head: the request's kind tile beside its title (the row's own
 * mark, one grammar on the row and here), the title in the heading face, and
 * one sentence for what it is for. No eyebrow (page-grammar §5).
 */
function RequestHeader({
  family,
  noun,
  title,
  sentence,
}: {
  family?: RequestFamily;
  noun?: string;
  title: string;
  sentence: string | null;
}) {
  return (
    <header className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex min-w-0 items-start gap-3">
        {family && (
          <span className="mt-1">
            <RequestKindTile family={family} noun={noun ?? title} />
          </span>
        )}
        <h2 className="line-clamp-3 min-w-0 break-words font-heading text-[24px] font-medium leading-tight text-foreground">
          {title}
        </h2>
      </div>
      {sentence && (
        <p className="text-[15px] leading-relaxed text-foreground/80">
          {sentence}
        </p>
      )}
    </header>
  );
}

/**
 * The decision drawn in place — no frame. How things work's "Diff" layout
 * reads a rule's change beside its list with it (founder B-1): the same
 * `ReviewDetail` the dock and drawer draw, never a copy.
 */
export function ReviewInline(props: DetailProps) {
  return <ReviewDetail {...props} />;
}

function ReviewDetail({
  open,
  viewer,
  onClose,
  liveAsk,
  onAskSettled,
  storyContext,
}: DetailProps) {
  const { detail } = open;
  const locale = useConsoleLocale();
  const story = useOpenStory(open.lens, storyContext, locale);
  return (
    <>
      {detail.kind === "ask" && (
        <AskAnswer
          key={`${detail.sessionId}:${detail.label}`}
          slot={detail.slot}
          live={liveAsk}
          onSettled={onAskSettled}
          onClose={onClose}
          // The frame's title IS the question, and its sentence the why:
          // each read once.
          showHeading={false}
          showContext={!open.sentence}
          story={story}
          identity={viewer.identity}
          barClassName={DECISION_BAR_PIN}
        />
      )}
      {detail.kind === "proposal" && (
        <ProposalBody
          key={detail.proposalId}
          proposalId={detail.proposalId}
          viewer={viewer}
          onClose={onClose}
          story={story}
        />
      )}
      {detail.kind === "issuer" && (
        <IssuerBody
          key={detail.issuerId}
          issuerId={detail.issuerId}
          viewer={viewer}
          onClose={onClose}
        />
      )}
      {detail.kind === "app-request" && (
        <AppRequestBody
          key={detail.requestId}
          requestId={detail.requestId}
          viewer={viewer}
          onClose={onClose}
        />
      )}
    </>
  );
}

/**
 * The open request's story, from the row it was opened on and the page's one
 * context read. While the read is in flight (or failed) the story still has
 * its Now and what the row itself says comes next. A row the read does not
 * cover yet (it arrived after the cached read) is read again ONCE, and stays
 * "reading" meanwhile: an uncovered row is not a failed read (S1). Covered
 * by neither read, it tells only what the row itself carries.
 */
function useOpenStory(
  lens: LensRow | undefined,
  ctx: ReviewStoryContext | undefined,
  locale: ReturnType<typeof useConsoleLocale>
): { story: RequestStory | null; read: StoryRead } | undefined {
  const covered =
    !!lens && !!ctx?.context && Object.hasOwn(ctx.context.rows, lens.key);
  const uncovered = !!lens && ctx?.read.status === "ok" && !covered;
  // Once PER ROW: the re-read is keyed by the row it was asked for, so the
  // next uncovered row is read again too.
  const [asked, setAsked] = useState<{ key: string; at: number } | null>(null);
  const askedAt = lens && asked?.key === lens.key ? asked.at : null;
  useEffect(() => {
    if (uncovered && askedAt === null && ctx && lens) {
      setAsked({ key: lens.key, at: ctx.updatedAt });
      ctx.refetch();
    }
  }, [uncovered, askedAt, ctx, lens]);
  if (!lens || !ctx) return undefined;
  if (uncovered) {
    const reread = askedAt !== null && ctx.updatedAt > askedAt;
    return reread
      ? { story: requestStory(lens, null, { locale }), read: { status: "off" } }
      : {
          story: requestStory(lens, null, { locale }),
          read: { status: "loading" },
        };
  }
  return {
    story: requestStory(lens, ctx.context, { locale }),
    read: ctx.read,
  };
}

// ─── Shared parts ────────────────────────────────────────────────────────────

/** The five trust signals, in the order a careful reviewer asks them. */
function TrustSignals({
  who,
  what,
  where,
  viewer,
  when,
}: {
  who: ReactNode;
  what: ReactNode;
  where: ReactNode;
  viewer: ReviewViewer;
  when: ReactNode;
}) {
  const t = useT(DRAWER_CATALOGS);
  const rows: Array<[string, ReactNode]> = [
    [t("trust.who"), who],
    [t("trust.what"), what],
    [t("trust.where"), where],
    [
      t("trust.approver"),
      viewer.identity
        ? withMark(
            t("trust.approverNamed", { mark: NAME_MARK }),
            <strong className="font-medium text-foreground">
              {viewer.identity}
            </strong>
          )
        : t("trust.approverYou"),
    ],
    [t("trust.when"), when],
  ];
  return (
    <dl className="flex flex-col gap-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-[12px] font-medium text-foreground/70">
            {label}
          </dt>
          <dd className="text-[13px] leading-relaxed text-foreground/85">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A catalog sentence with ONE name drawn in its own type (bold, mono) where
 * the message holds `{mark}` (`NAME_MARK`): the words stay one message.
 */
function withMark(sentence: string, mark: ReactNode): ReactNode {
  const [before, after] = sentence.split(NAME_MARK);
  return (
    <>
      {before}
      {mark}
      {after}
    </>
  );
}

/** "Your pod pod.example.com, Builder space only." `space` null = the whole pod. */
function PodWhere({
  viewer,
  space,
}: {
  viewer: ReviewViewer;
  space: string | null;
}) {
  const t = useT(DRAWER_CATALOGS);
  const scope = space ? t("where.space", { space }) : t("where.everywhere");
  return viewer.podHost
    ? withMark(
        t("where.podHost", { mark: NAME_MARK, scope }),
        <span className="font-mono text-[12px]">{viewer.podHost}</span>
      )
    : t("where.pod", { scope });
}

function WhyApproval({ children }: { children: ReactNode }) {
  const t = useT(DRAWER_CATALOGS);
  return (
    <p className="flex items-start gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground/75 ring-1 ring-inset ring-foreground/10">
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground/85">
          {t("approval.lead")}
        </span>{" "}
        {children}
      </span>
    </p>
  );
}

/**
 * The decision, pinned to the bottom of the scrolling detail. `-bottom-4`
 * and `-mx-6` undo the scroll container's `py-4 px-6` (the drawer body and
 * the dock body share them): a sticky box stops at the padding edge, which
 * would leave a strip of scrolling content showing under it.
 */
const DECISION_BAR_PIN = "-bottom-4 -mx-6 bg-content1 px-6 py-3";

function DecisionBar({ children }: { children: ReactNode }) {
  return (
    <div
      className={`sticky z-10 border-t border-foreground/[0.06] ${DECISION_BAR_PIN}`}
    >
      {children}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-12">
      <Spinner size="sm" label={label} />
    </div>
  );
}

function Unreadable({ message }: { message: string }) {
  return (
    <p className="py-8 text-center text-[12.5px] text-status-down">{message}</p>
  );
}

/**
 * Approve + Reject with a reason, for the kinds whose receiver has no
 * decision card of its own to reuse here. A grant request is rejected, as a
 * proposal is (the verb follows the object), through the vocabulary door.
 * The reason is required: it is what the requester reads.
 */
function DecideButtons({
  approveLabel,
  approveColor = "success",
  canApprove = true,
  approving,
  rejecting,
  onApprove,
  onReject,
  minReason = 1,
}: {
  approveLabel: string;
  /** `danger` for a risky approve (an unverified account); never warning. */
  approveColor?: "success" | "danger";
  canApprove?: boolean;
  approving: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  minReason?: number;
}) {
  const t = useT(DRAWER_CATALOGS);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const busy = approving || rejecting;
  if (open) {
    return (
      <DecisionBar>
        <div className="flex flex-col gap-2">
          <Textarea
            value={reason}
            onValueChange={setReason}
            label={t("decide.reason")}
            description={t("decide.reasonHint")}
            minRows={2}
            isDisabled={busy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              color="danger"
              className="min-h-10"
              isLoading={rejecting}
              isDisabled={busy || reason.trim().length < minReason}
              onPress={() => onReject(reason.trim())}
            >
              {t("decide.confirmReject")}
            </Button>
            <Button
              variant="light"
              className="min-h-10"
              isDisabled={busy}
              onPress={() => setOpen(false)}
            >
              {t("decide.cancel")}
            </Button>
          </div>
        </div>
      </DecisionBar>
    );
  }
  return (
    <DecisionBar>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          color={approveColor}
          className="min-h-10"
          startContent={<Check size={16} />}
          isLoading={approving}
          isDisabled={busy || !canApprove}
          onPress={onApprove}
        >
          {approveLabel}
        </Button>
        <Button
          color="danger"
          variant="flat"
          className="min-h-10"
          startContent={<X size={16} />}
          isDisabled={busy}
          onPress={() => setOpen(true)}
        >
          {t("decide.reject", { verb: resolveActionLabel("reject") })}
        </Button>
      </div>
    </DecisionBar>
  );
}

/**
 * Refresh every read a decision changes: the rows, the badges, the proposal,
 * and Home's needs-you (`diagnose.global` counts what waits on a person).
 */
function useAfterDecision() {
  const utils = trpc.useUtils();
  return () => {
    void utils.signals.invalidate();
    void utils.proposals.invalidate();
    void utils.diagnose.global.invalidate();
  };
}

// ─── Proposal (and the agent-connect proposal) ──────────────────────────────

/** `{ keyId, agentType }` when this proposal is an AI's pending key asking to connect. */
function agentConnectOf(
  p: ProposalReviewData
): { keyId: string; agentType: string; name: string | null } | null {
  if (p.targetType !== "agent" || p.proposalType !== "connect") return null;
  const d = (p.data ?? {}) as Record<string, unknown>;
  if (typeof d.keyId !== "string") return null;
  return {
    keyId: d.keyId,
    agentType: typeof d.agentType === "string" ? d.agentType : "agent",
    name: typeof d.name === "string" ? d.name : null,
  };
}

function ProposalBody({
  proposalId,
  viewer,
  onClose,
  story,
}: {
  proposalId: string;
  viewer: ReviewViewer;
  onClose: () => void;
  story?: { story: RequestStory | null; read: StoryRead };
}) {
  const { query, sourceExits, sourceState, workspaceName } =
    useProposalReview(proposalId);
  const afterDecision = useAfterDecision();
  useEffect(() => {
    if (query.error) redirectToLoginIfUnauthorized(query.error);
  }, [query.error]);

  if (query.isLoading)
    return <Loading label={proposalPageT()("read.loading")} />;
  const p = query.data;
  const failure = requestReadFailure(query.error, !!p);
  if (failure || !p)
    return (
      <div className="py-6">
        <RequestUnreadable
          failure={failure}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      </div>
    );

  // A decided connection shows its outcome on the proposal review below; only
  // a live one is decided through the agent door.
  const agent = isActionable(String(p.status)) ? agentConnectOf(p) : null;
  if (agent) {
    // Only names the pod resolved — never an id, never a guess.
    const from = sourceExits.map((s) => s.target.label).filter(Boolean);
    return (
      <AgentConnectBody
        agent={agent}
        proposalId={p.id}
        requester={proposalRequester(p)}
        where={<PodWhere viewer={viewer} space={workspaceName ?? null} />}
        when={
          from.length > 0
            ? drawerT()("agent.whenFrom", {
                at: formatTimestamp(p.createdAt),
                ago: formatRelative(p.createdAt),
                from: from.join(", "),
              })
            : drawerT()("agent.when", {
                at: formatTimestamp(p.createdAt),
                ago: formatRelative(p.createdAt),
              })
        }
        viewer={viewer}
        onDone={() => {
          afterDecision();
          onClose();
        }}
      />
    );
  }

  // The review draws provenance, the change, why, the decision and the one
  // "Advanced" itself; the drawer adds nothing but its frame.
  return (
    <ProposalReviewBody
      proposal={p}
      sourceExits={sourceExits}
      sourceState={sourceState}
      workspaceName={workspaceName}
      identity={viewer.identity}
      onDecided={() => {
        afterDecision();
        void query.refetch();
      }}
      barClassName={DECISION_BAR_PIN}
      story={story}
    />
  );
}

function AgentConnectBody({
  agent: facts,
  proposalId,
  requester,
  where,
  when,
  viewer,
  onDone,
}: {
  agent: { keyId: string; agentType: string; name: string | null };
  proposalId: string;
  requester: string | null;
  where: ReactNode;
  when: ReactNode;
  viewer: ReviewViewer;
  onDone: () => void;
}) {
  const rt = useT(REQUEST_CATALOGS);
  const t = useT(DRAWER_CATALOGS);
  const agent = useAgentConnect(facts.keyId, facts.agentType);
  const { step } = agent;
  useEffect(() => {
    if (step.kind === "approved") {
      addToast({ title: step.outcome.title, color: "success" });
      onDone();
    } else if (step.kind === "rejected") {
      addToast({ title: drawerT()("agent.rejected"), color: "default" });
      onDone();
    }
    // `onDone` is a fresh closure each render; the step is what changes.
  }, [step.kind]);

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={withMark(
          requester
            ? t("agent.whoBy", { mark: NAME_MARK, requester })
            : t("agent.who", { mark: NAME_MARK }),
          <strong className="font-medium text-foreground">
            {agent.connections?.title ?? facts.name ?? t("agent.unnamed")}
          </strong>
        )}
        what={t("agent.what")}
        where={where}
        viewer={viewer}
        when={when}
      />
      <WhyApproval>{t("agent.needsApproval")}</WhyApproval>
      {step.kind === "error" && (
        <Alert color="danger" title={t("agent.failed")}>
          {step.message}
        </Alert>
      )}
      <AgentConnectDecision agent={agent} agentType={facts.agentType} />
      <AdvancedPanel
        ids={[
          { label: rt("detail.proposalId"), value: proposalId },
          { label: t("agent.keyId"), value: facts.keyId },
        ]}
      />
    </div>
  );
}

// ─── Trusted issuer ──────────────────────────────────────────────────────────

function IssuerBody({
  issuerId,
  viewer,
  onClose,
}: {
  issuerId: string;
  viewer: ReviewViewer;
  onClose: () => void;
}) {
  const list = trpc.trustedIssuers.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const utils = trpc.useUtils();
  const afterDecision = useAfterDecision();
  const t = useT(DRAWER_CATALOGS);
  const [scopes, setScopes] = useState<TrustedIssuerScope[]>(
    DEFAULT_ISSUER_SCOPES
  );
  const done = (title: string, color: "success" | "default") => {
    addToast({ title, color });
    void utils.trustedIssuers.list.invalidate();
    afterDecision();
    onClose();
  };
  const fail =
    (title: string) =>
    (err: { message: string; data?: { code?: string | null } | null }) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      // CONFLICT = the issuer's status moved (someone decided first): not a
      // failure, so say so calmly and refresh to what is true now.
      if (err.data?.code === "CONFLICT") {
        addToast({
          title: t("decide.alreadyDecided"),
          description: err.message,
          color: "default",
        });
        void utils.trustedIssuers.list.invalidate();
        afterDecision();
        onClose();
        return;
      }
      addToast({ title, description: err.message, color: "danger" });
    };
  // With the proof of presence: an issuer's reach on the pod is governance (W3).
  const approve = useApproveIssuer(
    (input) => {
      const found = list.data?.find((i) => i.id === input.id);
      return found
        ? buildObjectActionTitle({
            action: "approve",
            objectKind: "trusted_issuer",
            objectName: found.displayName,
          })
        : null;
    },
    {
      onSuccess: () => done(t("issuer.approved"), "success"),
      onError: fail(t("issuer.approveFailed")),
    }
  );
  const reject = trpc.trustedIssuers.reject.useMutation({
    onSuccess: () => done(t("issuer.rejected"), "default"),
    onError: fail(t("issuer.rejectFailed")),
  });

  if (list.isLoading) return <Loading label={t("issuer.loading")} />;
  const issuer = list.data?.find((i) => i.id === issuerId);
  if (list.error || !issuer)
    return <Unreadable message={t("issuer.unreadable")} />;
  const via = (issuer.initialRequestData as { requestedVia?: unknown } | null)
    ?.requestedVia;

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={withMark(
          t("issuer.who", { mark: NAME_MARK }),
          <>
            <strong className="font-medium text-foreground">
              {issuer.displayName}
            </strong>{" "}
            (<span className="font-mono text-[12px]">{issuer.issuerUrl}</span>)
          </>
        )}
        what={t("issuer.what")}
        where={<PodWhere viewer={viewer} space={null} />}
        viewer={viewer}
        when={
          typeof via === "string"
            ? t("issuer.whenVia", {
                at: formatTimestamp(issuer.createdAt),
                ago: formatRelative(issuer.createdAt),
                via,
              })
            : t("issuer.when", {
                at: formatTimestamp(issuer.createdAt),
                ago: formatRelative(issuer.createdAt),
              })
        }
      />
      <WhyApproval>{t("issuer.needsApproval")}</WhyApproval>
      {issuer.status !== "pending" ? (
        <Alert
          color="default"
          variant="flat"
          title={t("decide.alreadyDecided")}
        >
          {t("issuer.notPending")}
        </Alert>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-medium text-foreground">
              {t("issuer.scopes")}
            </p>
            <IssuerScopePicker
              selected={scopes}
              onChange={setScopes}
              isDisabled={approve.isPending || reject.isPending}
            />
          </div>
          <DecideButtons
            approveLabel={t("issuer.approve")}
            canApprove={scopes.length > 0}
            approving={approve.isPending}
            rejecting={reject.isPending}
            onApprove={() =>
              approve.mutate({ id: issuer.id, allowedScopes: scopes })
            }
            onReject={(reason) => reject.mutate({ id: issuer.id, reason })}
          />
        </>
      )}
      <AdvancedPanel
        ids={[
          { label: t("issuer.id"), value: issuer.id },
          { label: t("issuer.url"), value: issuer.issuerUrl },
        ]}
        raw={issuer.initialRequestData ?? undefined}
      />
    </div>
  );
}

// ─── App connection request ──────────────────────────────────────────────────

function AppRequestBody({
  requestId,
  viewer,
  onClose,
}: {
  requestId: string;
  viewer: ReviewViewer;
  onClose: () => void;
}) {
  // No return-to-app redirect here: the requester's browser is elsewhere,
  // and the receiver page is what sends it back. A decision closes the drawer.
  const afterDecision = useAfterDecision();
  const t = useT(DRAWER_CATALOGS);
  const review = useConnectionRequest(requestId, {
    onApproved: () => {
      addToast({ title: drawerT()("app.allowed"), color: "success" });
      afterDecision();
      onClose();
    },
    onRejected: () => {
      addToast({ title: drawerT()("app.rejected"), color: "default" });
      afterDecision();
      onClose();
    },
  });
  const { request } = review;
  const gate = useAccountLinkGate(request.data);
  useEffect(() => {
    if (request.error) redirectToLoginIfUnauthorized(request.error);
  }, [request.error]);

  if (request.isLoading) return <Loading label={t("app.loading")} />;
  const data = request.data;
  if (request.error || !data)
    return <Unreadable message={t("app.unreadable")} />;
  const isPending = data.status === "pending";

  // An account link: the decision is about a person, not an origin.
  if (gate.link) {
    return (
      <div className="flex flex-col gap-5 pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            {gate.link.heading}
          </p>
          <p className="text-sm text-foreground/70">{gate.link.body}</p>
        </div>
        {gate.needsAcknowledge && isPending && data.canReview ? (
          <UnverifiedAccountNotice
            acknowledged={gate.acknowledged}
            onAcknowledge={gate.setAcknowledged}
            isDisabled={review.isWorking}
          />
        ) : null}
        <ConnectionRequestDetails data={data} isPending={isPending} />
        {review.actionError && (
          <Alert color="danger" title={t("decide.failed")}>
            {review.actionError}
          </Alert>
        )}
        {isPending && data.canReview ? (
          <DecideButtons
            approveLabel={gate.approveLabel}
            approveColor={gate.needsAcknowledge ? "danger" : "success"}
            canApprove={gate.canApprove}
            approving={review.approving}
            rejecting={review.rejecting}
            onApprove={review.approve}
            onReject={review.reject}
            minReason={3}
          />
        ) : null}
        <AdvancedPanel
          ids={[
            { label: t("app.requestId"), value: data.id },
            { label: t("app.appId"), value: data.clientId },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={withMark(
          data.publisherUrl
            ? t("app.whoBy", {
                mark: NAME_MARK,
                publisher: data.publisherUrl,
              })
            : t("app.who", { mark: NAME_MARK }),
          <strong className="font-medium text-foreground">
            {data.displayName}
          </strong>
        )}
        what={withMark(
          t("app.what", { mark: NAME_MARK }),
          <span className="font-mono text-[12px]">{data.requestedOrigin}</span>
        )}
        where={<PodWhere viewer={viewer} space={null} />}
        viewer={viewer}
        when={t("app.when", { expiry: requestExpiry(data) })}
      />
      <WhyApproval>{t("app.needsApproval")}</WhyApproval>
      <ConnectionRequestDetails data={data} isPending={isPending} />
      {matchesApprovedConnection(data) && (
        <Alert color="success" variant="flat" title={t("app.alreadyAllowed")}>
          {t("app.alreadyAllowedBody")}
        </Alert>
      )}
      {review.actionError && (
        <Alert color="danger" title={t("decide.failed")}>
          {review.actionError}
        </Alert>
      )}
      {isPending && data.canReview ? (
        <DecideButtons
          approveLabel={t("app.approve")}
          approving={review.approving}
          rejecting={review.rejecting}
          onApprove={review.approve}
          onReject={review.reject}
          minReason={3}
        />
      ) : null}
      <AdvancedPanel
        ids={[
          { label: t("app.requestId"), value: data.id },
          { label: t("app.appId"), value: data.clientId },
        ]}
      />
    </div>
  );
}
