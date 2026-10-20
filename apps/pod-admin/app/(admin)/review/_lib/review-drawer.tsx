"use client";

/**
 * Review's detail — one decision, read before it is made. Docked beside the
 * list from `lg` up (`ReviewDock`, non-modal: the list stays usable), a
 * drawer below it (`ReviewDrawer`); both draw the same `ReviewDetail`.
 *
 * Every kind opens on the same five TRUST SIGNALS (who is asking, what it
 * will be able to do, where, who approves, when and from where) and the
 * policy's "why this needs approval", then decides through the SAME UI its
 * own receiver page uses — never a copy:
 *
 *   proposal       → `ProposalDecision` (+ "always approve"), `/proposal/[id]`
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
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { DetailDrawer } from "../../components/detail-drawer";
import { proposalHeading } from "../../../proposal/[id]/proposal-heading";
import {
  ProposalDecision,
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
  title: string;
  /** When the row's ask was raised (ISO), for "asked 2h ago". */
  occurredAt?: string | null;
}

interface ReviewFrameProps {
  open: OpenReview | null;
  viewer: ReviewViewer;
  onClose: () => void;
  /** An open ask's question as the pod holds it NOW (null = moved on). */
  liveAsk: AskSlot | null;
  /** An open ask was answered, done or handed back. */
  onAskSettled: () => void;
}

type DetailProps = Omit<ReviewFrameProps, "open"> & { open: OpenReview };

/** Below `lg`: the decision in a modal drawer over the list. */
export function ReviewDrawer({ open, ...rest }: ReviewFrameProps) {
  return (
    <DetailDrawer
      isOpen={open !== null}
      onClose={rest.onClose}
      title={open?.title ?? "Review"}
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
    <aside
      aria-label={
        open.detail.kind === "ask" ? "Question details" : "Request details"
      }
      className="sticky top-4 flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col overflow-hidden rounded-lg bg-content1 ring-1 ring-inset ring-foreground/10"
    >
      <div className="flex items-center gap-3 border-b border-foreground/[0.06] px-6 py-4">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">
          {open.title}
        </h2>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          onPress={onClose}
          aria-label="Close details"
          className="shrink-0 text-foreground/65 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ReviewDetail open={open} {...rest} />
      </div>
    </aside>
  );
}

function ReviewDetail({
  open,
  viewer,
  onClose,
  liveAsk,
  onAskSettled,
}: DetailProps) {
  const { detail } = open;
  return (
    <>
      {detail.kind === "ask" && (
        <AskAnswer
          key={`${detail.sessionId}:${detail.label}`}
          slot={detail.slot}
          live={liveAsk}
          occurredAt={open.occurredAt ?? null}
          onSettled={onAskSettled}
          onClose={onClose}
        />
      )}
      {detail.kind === "proposal" && (
        <ProposalBody
          key={detail.proposalId}
          proposalId={detail.proposalId}
          viewer={viewer}
          onClose={onClose}
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
  const rows: Array<[string, ReactNode]> = [
    ["Who is asking", who],
    ["What it will be able to do", what],
    ["Where", where],
    [
      "Who approves",
      viewer.identity ? (
        <>
          You are signed in as{" "}
          <strong className="font-medium text-foreground">
            {viewer.identity}
          </strong>
          . Your decision is recorded in the Audit log.
        </>
      ) : (
        "You. Your decision is recorded in the Audit log."
      ),
    ],
    ["When and from where", when],
  ];
  return (
    <dl className="flex flex-col gap-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
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

/** "Your pod pod.example.com, Builder space only." */
function podWhere(viewer: ReviewViewer, scope: string): ReactNode {
  return (
    <>
      Your pod{" "}
      {viewer.podHost ? (
        <span className="font-mono text-[12px]">{viewer.podHost}</span>
      ) : null}
      {viewer.podHost ? ", " : ""}
      {scope}
    </>
  );
}

function WhyApproval({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground/75 ring-1 ring-inset ring-foreground/10">
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground/85">
          Why this needs approval.
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
function DecisionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky -bottom-4 z-10 -mx-6 border-t border-foreground/[0.06] bg-content1 px-6 py-3">
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
 * Approve + Reject-with-reason, for the kinds whose receiver has no decision
 * card of its own to reuse here. The reason is required: it is what the
 * requester reads.
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
            label="Reason"
            description="The requester sees this, so say what would change your mind."
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
              Confirm reject
            </Button>
            <Button
              variant="light"
              className="min-h-10"
              isDisabled={busy}
              onPress={() => setOpen(false)}
            >
              Cancel
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
          Reject with reason…
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
}: {
  proposalId: string;
  viewer: ReviewViewer;
  onClose: () => void;
}) {
  const { query, sourceExits, workspaceName } = useProposalReview(proposalId);
  const afterDecision = useAfterDecision();
  useEffect(() => {
    if (query.error) redirectToLoginIfUnauthorized(query.error);
  }, [query.error]);

  if (query.isLoading) return <Loading label="Reading the proposal…" />;
  const p = query.data;
  if (query.error || !p)
    return (
      <Unreadable message="This proposal couldn't be loaded — it may have been withdrawn, or you may not have access to it." />
    );

  const appName = p.appName;
  // Only names the pod resolved — never an id, never a guess.
  const requester = appName
    ? `${appName}${p.authorName ? `, for ${p.authorName}` : ""}`
    : (p.authorName ?? null);
  const from = sourceExits.map((s) => s.target.label).filter(Boolean);
  const when = (
    <>
      {formatTimestamp(p.createdAt)} ({formatRelative(p.createdAt)})
      {from.length > 0 ? `, from ${from.join(", ")}` : ""}.
    </>
  );
  const where = podWhere(
    viewer,
    workspaceName ? `${workspaceName} space only.` : "across the pod."
  );

  // A decided connection shows its outcome on the proposal card below; only a
  // live one is decided through the agent door.
  const agent = isActionable(String(p.status)) ? agentConnectOf(p) : null;
  if (agent) {
    return (
      <AgentConnectBody
        agent={agent}
        proposalId={p.id}
        requester={requester}
        where={where}
        when={when}
        viewer={viewer}
        onDone={() => {
          afterDecision();
          onClose();
        }}
      />
    );
  }

  const { heading } = proposalHeading(p, p.request.data ?? p.data);
  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={requester ?? "Not recorded on this request."}
        what={heading}
        where={where}
        viewer={viewer}
        when={when}
      />
      <ProposalDecision
        proposal={p}
        sourceExits={sourceExits}
        onDecided={() => {
          afterDecision();
          void query.refetch();
        }}
      />
      <AdvancedPanel
        ids={[
          { label: "Proposal id", value: p.id },
          { label: "Change", value: `${p.targetType} · ${p.proposalType}` },
        ]}
        raw={p.request}
      />
    </div>
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
  const agent = useAgentConnect(facts.keyId, facts.agentType);
  const { step } = agent;
  useEffect(() => {
    if (step.kind === "approved") {
      addToast({ title: step.outcome.title, color: "success" });
      onDone();
    } else if (step.kind === "rejected") {
      addToast({ title: "Connection rejected", color: "default" });
      onDone();
    }
    // `onDone` is a fresh closure each render; the step is what changes.
  }, [step.kind]);

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={
          <>
            An agent named{" "}
            <strong className="font-medium text-foreground">
              {agent.connections?.title ?? facts.name ?? "this agent"}
            </strong>
            {requester ? `, connected by ${requester}` : ""}.
          </>
        }
        what="Everything listed below, and nothing else. Its writes still follow your review rules."
        where={where}
        viewer={viewer}
        when={when}
      />
      <WhyApproval>
        New agents need a person to approve their access.
      </WhyApproval>
      {step.kind === "error" && (
        <Alert color="danger" title="Couldn't process the request">
          {step.message}
        </Alert>
      )}
      <AgentConnectDecision agent={agent} agentType={facts.agentType} />
      <AdvancedPanel
        ids={[
          { label: "Proposal id", value: proposalId },
          { label: "Key id", value: facts.keyId },
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
          title: "Already decided",
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
  const approve = trpc.trustedIssuers.approve.useMutation({
    onSuccess: () => done("Issuer approved", "success"),
    onError: fail("Approval failed"),
  });
  const reject = trpc.trustedIssuers.reject.useMutation({
    onSuccess: () => done("Issuer rejected", "default"),
    onError: fail("Reject failed"),
  });

  if (list.isLoading) return <Loading label="Reading the issuer…" />;
  const issuer = list.data?.find((i) => i.id === issuerId);
  if (list.error || !issuer)
    return (
      <Unreadable message="This issuer couldn't be loaded — it may already have been decided." />
    );
  const via = (issuer.initialRequestData as { requestedVia?: unknown } | null)
    ?.requestedVia;

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={
          <>
            An outside service,{" "}
            <strong className="font-medium text-foreground">
              {issuer.displayName}
            </strong>{" "}
            (<span className="font-mono text-[12px]">{issuer.issuerUrl}</span>
            ), asking that the identity tokens it signs be accepted here.
          </>
        }
        what="Only the scopes you tick below."
        where={podWhere(viewer, "across the pod.")}
        viewer={viewer}
        when={
          <>
            {formatTimestamp(issuer.createdAt)} (
            {formatRelative(issuer.createdAt)})
            {typeof via === "string" ? `, from a ${via} request` : ""}.
          </>
        }
      />
      <WhyApproval>
        An outside service can vouch for who is calling this pod only after a
        pod admin trusts it, and only for what you allow.
      </WhyApproval>
      {issuer.status !== "pending" ? (
        <Alert color="default" variant="flat" title="Already decided">
          This issuer is no longer waiting for approval.
        </Alert>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-medium text-foreground">
              Allowed scopes
            </p>
            <IssuerScopePicker
              selected={scopes}
              onChange={setScopes}
              isDisabled={approve.isPending || reject.isPending}
            />
          </div>
          <DecideButtons
            approveLabel="Approve access"
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
          { label: "Issuer id", value: issuer.id },
          { label: "Issuer URL", value: issuer.issuerUrl },
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
  const review = useConnectionRequest(requestId, {
    onApproved: () => {
      addToast({ title: "Origin allowed", color: "success" });
      afterDecision();
      onClose();
    },
    onRejected: () => {
      addToast({ title: "Request declined", color: "default" });
      afterDecision();
      onClose();
    },
  });
  const { request } = review;
  const gate = useAccountLinkGate(request.data);
  useEffect(() => {
    if (request.error) redirectToLoginIfUnauthorized(request.error);
  }, [request.error]);

  if (request.isLoading) return <Loading label="Reading the request…" />;
  const data = request.data;
  if (request.error || !data)
    return (
      <Unreadable message="This request couldn't be opened — it may have expired or already been decided." />
    );
  const isPending = data.status === "pending";

  // An account link: the decision is about a person, not an origin.
  if (gate.link) {
    return (
      <div className="flex flex-col gap-5 pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            {gate.link.heading}
          </p>
          <p className="text-sm text-foreground/65">{gate.link.body}</p>
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
          <Alert color="danger" title="Action couldn’t be completed">
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
            { label: "Request id", value: data.id },
            { label: "App id", value: data.clientId },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-4">
      <TrustSignals
        who={
          <>
            An app named{" "}
            <strong className="font-medium text-foreground">
              {data.displayName}
            </strong>
            {data.publisherUrl ? `, published by ${data.publisherUrl}` : ""}.
          </>
        }
        what={
          <>
            Call this pod&apos;s API from{" "}
            <span className="font-mono text-[12px]">
              {data.requestedOrigin}
            </span>{" "}
            in a browser. No data access and no membership — people still need
            to be members.
          </>
        }
        where={podWhere(viewer, "across the pod.")}
        viewer={viewer}
        when={<>Waiting now; the request expires {requestExpiry(data)}.</>}
      />
      <WhyApproval>
        A website can call this pod from a browser only after an owner allows
        its exact address.
      </WhyApproval>
      <ConnectionRequestDetails data={data} isPending={isPending} />
      {matchesApprovedConnection(data) && (
        <Alert color="success" variant="flat" title="Already allowed">
          This origin is already on the allowlist for this app; the requester
          only needs to choose Check connection.
        </Alert>
      )}
      {review.actionError && (
        <Alert color="danger" title="Action couldn’t be completed">
          {review.actionError}
        </Alert>
      )}
      {isPending && data.canReview ? (
        <DecideButtons
          approveLabel="Allow this origin"
          approving={review.approving}
          rejecting={review.rejecting}
          onApprove={review.approve}
          onReject={review.reject}
          minReason={3}
        />
      ) : null}
      <AdvancedPanel
        ids={[
          { label: "Request id", value: data.id },
          { label: "App id", value: data.clientId },
        ]}
      />
    </div>
  );
}
