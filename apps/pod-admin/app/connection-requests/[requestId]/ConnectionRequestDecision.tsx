"use client";

/**
 * The app connection-request DECISION, shared by the
 * `/connection-requests/[requestId]` receiver and the console's Review drawer:
 *
 *   `useConnectionRequest`     — the request, Allow / Decline, the decline
 *                                reason and any action error. What happens
 *                                AFTER a decision is the host's: the receiver
 *                                sends a requester's browser back to its app
 *                                (`returnUrl`); the drawer only closes.
 *   `ConnectionRequestDetails` — the fields a reviewer must read before
 *                                deciding, and what approval means.
 */

import { useId, useState } from "react";
import { Accordion, AccordionItem, Alert, Checkbox, Chip } from "@heroui/react";
import { ArrowRight, ShieldAlert, ShieldCheck } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { applicationConnectionCapabilities } from "../../_lib/application-connection-capabilities";
import { accountLinkReview } from "../../_lib/requester-account";

export function useConnectionRequest(
  requestId: string,
  handlers: {
    onApproved: (result: { returnUrl: string }) => void | Promise<void>;
    onRejected: () => void | Promise<void>;
  }
) {
  const utils = trpc.useUtils();
  const request = trpc.applicationConnections.getReviewRequest.useQuery(
    { requestId },
    { enabled: Boolean(requestId), retry: false }
  );
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      utils.applicationConnections.getReviewRequest.invalidate({ requestId }),
      utils.applicationConnections.list.invalidate(),
      utils.signals.invalidate(),
    ]);
  }

  const approve = trpc.applicationConnections.approveRequest.useMutation({
    onSuccess: async (data) => {
      setActionError(null);
      await refresh();
      await handlers.onApproved(data);
    },
    onError: (error) => {
      if (redirectToLoginIfUnauthorized(error)) return;
      setActionError(
        error.message ||
          "We couldn’t approve this request. Refresh and try again."
      );
    },
  });
  const reject = trpc.applicationConnections.rejectRequest.useMutation({
    onSuccess: async () => {
      setActionError(null);
      await refresh();
      await handlers.onRejected();
    },
    onError: (error) => {
      if (redirectToLoginIfUnauthorized(error)) return;
      setActionError(
        error.message ||
          "We couldn’t decline this request. Refresh and try again."
      );
    },
  });

  return {
    request,
    approve: () => approve.mutate({ requestId }),
    /** Decline with `why`, or with the reason typed into this hook's field. */
    reject: (why: string = reason) =>
      reject.mutate({ requestId, reason: why.trim() }),
    approving: approve.isPending,
    rejecting: reject.isPending,
    isWorking: approve.isPending || reject.isPending,
    reason,
    setReason,
    /** A decline needs a reason the requester can act on (≥ 3 characters). */
    canDecline: reason.trim().length >= 3,
    actionError,
  };
}

export type ConnectionRequestData = NonNullable<
  ReturnType<typeof useConnectionRequest>["request"]["data"]
>;

/** The origin is already allowed for this app (owners only). */
export function matchesApprovedConnection(data: ConnectionRequestData) {
  return Boolean(
    (data as { matchingApprovedConnection?: boolean })
      .matchingApprovedConnection
  );
}

/** "12 Oct 2026, 17:46" — when the request's handoff lease ends. */
export function requestExpiry(data: ConnectionRequestData): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.expiresAt));
}

/**
 * An ACCOUNT LINK: the app asks to let a Synap account sign in as the Pod
 * member who started the request. Null for an origin-only request.
 */
export function accountLinkOf(data: ConnectionRequestData) {
  return data.requesterAccount
    ? accountLinkReview(data.requesterAccount, data.requesterMember)
    : null;
}

/**
 * The unverified-account gate: nobody vouched for the account, so approving
 * waits until the reviewer says they know who started the request.
 */
export function useAccountLinkGate(data: ConnectionRequestData | undefined) {
  const [acknowledged, setAcknowledged] = useState(false);
  const link = data ? accountLinkOf(data) : null;
  const needsAcknowledge = Boolean(link && !link.account.verified);
  return {
    link,
    needsAcknowledge,
    acknowledged,
    setAcknowledged,
    canApprove: !needsAcknowledge || acknowledged,
    approveLabel: link
      ? needsAcknowledge
        ? "Give access anyway"
        : "Give access"
      : "Allow this origin",
    /** A risky approve is `danger`, never a warning-coloured button. */
    approveColor: needsAcknowledge ? ("danger" as const) : ("primary" as const),
  };
}

/** "Nobody vouched for this account" + the acknowledgement that unlocks it. */
export function UnverifiedAccountNotice({
  acknowledged,
  onAcknowledge,
  isDisabled,
}: {
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  isDisabled?: boolean;
}) {
  return (
    <Alert color="warning" title="Nobody vouched for this account">
      <div className="flex flex-col gap-2">
        <p>
          The app could not prove which Synap account asked. Give access only if
          you know who started this request.
        </p>
        <Checkbox
          isSelected={acknowledged}
          onValueChange={onAcknowledge}
          isDisabled={isDisabled}
        >
          I know who started this request
        </Checkbox>
      </div>
    </Alert>
  );
}

/**
 * Who gets in, as whom: the Pod member, then the Synap account that will sign
 * in as them, each with its mark.
 */
export function AccountLinkSection({
  link,
}: {
  link: NonNullable<ReturnType<typeof accountLinkOf>>;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-medium border border-divider p-3"
    >
      <h2 id={headingId} className="text-xs font-medium text-foreground/65">
        Who gets access
      </h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div className="min-w-0">
          <p className="text-xs text-foreground/65">Pod member</p>
          <p className="mt-0.5 break-all text-sm font-medium text-foreground">
            {link.member.label}
          </p>
          {link.member.email && link.member.email !== link.member.label ? (
            <p className="break-all text-xs text-foreground/65">
              {link.member.email}
            </p>
          ) : null}
        </div>
        <ArrowRight
          aria-hidden="true"
          size={16}
          className="hidden text-foreground/50 sm:block"
        />
        <div className="min-w-0">
          <p className="text-xs text-foreground/65">Synap account</p>
          <div className="mt-0.5 flex items-start gap-2">
            {link.account.verified ? (
              <ShieldCheck
                aria-hidden="true"
                size={16}
                className="mt-0.5 shrink-0 text-success"
              />
            ) : (
              <ShieldAlert
                aria-hidden="true"
                size={16}
                className="mt-0.5 shrink-0 text-warning"
              />
            )}
            <p className="min-w-0 break-all text-sm font-medium text-foreground">
              {link.account.title}
            </p>
          </div>
          {link.account.verifiedBy ? (
            <p className="text-xs text-foreground/65">
              {link.account.verifiedBy}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip color={link.account.tone} variant="flat" size="sm">
          {link.account.mark}
        </Chip>
        {link.differentEmail ? (
          <Chip color="warning" variant="flat" size="sm">
            Different email
          </Chip>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The transport facts — origin, return URL, app id, issuer — folded away for
 * an account link, where the decision is about the person, not the origin.
 */
export function ConnectionTechnicalDetails({
  data,
}: {
  data: ConnectionRequestData;
}) {
  return (
    <Accordion className="px-0" variant="light">
      <AccordionItem
        key="technical"
        aria-label="Technical details"
        title={
          <span className="text-sm text-foreground/65">Technical details</span>
        }
      >
        <TransportDetails data={data} />
        {matchesApprovedConnection(data) ? (
          <p className="mt-3 text-xs text-foreground/65">
            Origin already allowed for this app.
          </p>
        ) : null}
      </AccordionItem>
    </Accordion>
  );
}

function TransportDetails({ data }: { data: ConnectionRequestData }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <Detail
        label="Browser origin (required decision)"
        value={data.requestedOrigin}
        mono
      />
      <Detail label="Return URL" value={data.requestedCallbackUrl} mono />
      <Detail label="App id" value={data.clientId} mono />
      <Detail
        label="Identity provider (separate Trust plane)"
        value={data.issuerUrl}
        mono
      />
      <Detail
        className="sm:col-span-2"
        label="Notes at registration"
        value={applicationConnectionCapabilities(data.requestedScopes)}
      />
      <Detail label="Request expires" value={requestExpiry(data)} />
      {data.publisherUrl ? (
        <Detail label="Publisher" value={data.publisherUrl} />
      ) : null}
    </dl>
  );
}

/**
 * What the reviewer must read before deciding. An account link names who gets
 * access and folds the transport facts away; an origin-only request shows the
 * transport facts and what allowing an origin means. A member who may not
 * review sees only when it expires.
 */
export function ConnectionRequestDetails({
  data,
  isPending,
}: {
  data: ConnectionRequestData;
  isPending: boolean;
}) {
  if (!data.canReview)
    return <Detail label="Request expires" value={requestExpiry(data)} />;
  const link = accountLinkOf(data);
  if (link) {
    return (
      <>
        <AccountLinkSection link={link} />
        <ConnectionTechnicalDetails data={data} />
      </>
    );
  }
  return (
    <>
      <TransportDetails data={data} />
      {isPending ? (
        <Alert
          color="warning"
          variant="flat"
          title="What approval means"
          startContent={<ShieldAlert aria-hidden="true" size={18} />}
        >
          Approving adds this browser origin to the Pod allowlist so the site
          may call the Pod API (CORS). It does not create membership or grant
          workspace access. The identity provider listed above is managed under
          Trust &amp; Keys; approving here may also ensure that provider is
          registered so sign-in tokens can be verified.
        </Alert>
      ) : null}
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-foreground/65">{label}</dt>
      <dd
        className={`mt-1 break-all text-sm text-foreground ${mono ? "font-mono text-[12px] leading-5" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
