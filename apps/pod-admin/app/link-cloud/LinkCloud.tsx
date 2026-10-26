"use client";

/**
 * The client half of /link-cloud. It reads the fragment ONCE, clears it from
 * the address bar and history, then:
 *   - no fragment       → leaves for Synap Cloud's confirm page;
 *   - `intent+assertion`→ proves this pod session to the pod's identity-link
 *                         door, then leaves for Synap Cloud's finish page;
 *   - `linked`          → done; `cancelled` → not linked.
 * Each outcome is one terminal card (Island grammar); a failure says what
 * happened in one sentence, with the detail behind "Copy details".
 */

import { useEffect, useRef, useState } from "react";
import { Button, CardBody } from "@heroui/react";
import { AlertCircle, CheckCircle2, Cloud } from "lucide-react";
import { resolveSignInWayLabel } from "@synap-core/types/vocabulary";
import { ReceiverShell } from "../_lib/receiver-shell";
import { ErrorNote } from "../_lib/copy-button";
import { publicPodUrl } from "../../lib/public-pod-url";
import type { CloudSignInDiscovery } from "../../lib/cloud-sign-in";
import {
  claimAccessFinishUrl,
  claimAccessStartUrl,
  linkThisPod,
  readLinkCloudFragment,
  type LinkThisPodResult,
} from "../../lib/link-cloud";

const CLOUD = resolveSignInWayLabel("synap_cloud");

type View =
  | { kind: "working" }
  | { kind: "linked" }
  | { kind: "cancelled" }
  | { kind: "off" }
  | { kind: "broken" }
  | {
      kind: "refused";
      reason: Exclude<LinkThisPodResult, { ok: true }>["reason"];
      detail: string;
    };

/** One sentence per refusal of the pod's door. */
const REFUSAL: Record<
  Exclude<LinkThisPodResult, { ok: true }>["reason"],
  string
> = {
  signed_out: "Your session on this pod ended. Sign in, then start again.",
  turned_off: `${CLOUD} sign-in is turned off for this pod.`,
  assertion_refused: `This pod links a ${CLOUD} account only when it uses the same email as your account here, and only for a few minutes. Start again.`,
  already_linked_elsewhere: `This pod account is already linked to another ${CLOUD} account, or that ${CLOUD} account to another account here.`,
  failed: "This pod could not link the account. Try again in a few minutes.",
};

export function LinkCloud({
  cloud,
  email,
}: {
  cloud: CloudSignInDiscovery | null;
  email: string | null;
}) {
  const [view, setView] = useState<View>({ kind: "working" });
  const ran = useRef(false);

  useEffect(() => {
    // Strict Mode mounts twice; the fragment is single-use.
    if (ran.current) return;
    ran.current = true;
    const fragment = readLinkCloudFragment(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (fragment.kind === "linked" || fragment.kind === "cancelled") {
      setView({ kind: fragment.kind });
      return;
    }
    if (fragment.kind === "broken") {
      setView({ kind: "broken" });
      return;
    }
    const podUrl = publicPodUrl();
    const issuer = cloud?.available ? cloud.issuerUrl : null;
    if (!issuer || !podUrl) {
      setView({ kind: "off" });
      return;
    }
    if (fragment.kind === "start") {
      const start = claimAccessStartUrl(issuer, podUrl);
      if (start) window.location.assign(start);
      else setView({ kind: "off" });
      return;
    }
    void (async () => {
      const r = await linkThisPod(podUrl, fragment.assertion);
      if (!r.ok) {
        setView({ kind: "refused", reason: r.reason, detail: r.detail });
        return;
      }
      const finish = claimAccessFinishUrl(
        issuer,
        fragment.intentId,
        r.receiptId
      );
      if (finish) window.location.assign(finish);
      else setView({ kind: "off" });
    })();
  }, [cloud]);

  let podHost: string | undefined;
  try {
    podHost = new URL(publicPodUrl() ?? "").host;
  } catch {
    podHost = undefined;
  }

  return (
    <ReceiverShell podHost={podHost} identity={email ?? undefined} width="sm">
      <CardBody className="flex flex-col gap-5 p-8">
        <Body view={view} />
      </CardBody>
    </ReceiverShell>
  );
}

function Body({ view }: { view: View }) {
  if (view.kind === "working") {
    return (
      <Outcome
        icon={<Cloud aria-hidden className="h-10 w-10 text-foreground/50" />}
        title={`Linking ${CLOUD}…`}
        text={`You'll go to ${CLOUD} and come back here.`}
        busy
      />
    );
  }
  if (view.kind === "linked") {
    return (
      <>
        <Outcome
          icon={<CheckCircle2 aria-hidden className="h-10 w-10 text-success" />}
          title={`${CLOUD} is linked`}
          text={`You can sign in to this pod with ${CLOUD}, and the pod shows in your ${CLOUD} account.`}
        />
        <Exits />
      </>
    );
  }
  if (view.kind === "cancelled") {
    return (
      <>
        <Outcome
          icon={
            <AlertCircle aria-hidden className="h-10 w-10 text-foreground/30" />
          }
          title={`${CLOUD} is not linked`}
          text="Nothing changed. You can link it later from Settings › Security."
        />
        <Exits />
      </>
    );
  }
  if (view.kind === "off") {
    return (
      <>
        <Outcome
          icon={
            <AlertCircle aria-hidden className="h-10 w-10 text-foreground/30" />
          }
          title={`${CLOUD} is off for this pod`}
          text={`The pod's owner chose not to allow ${CLOUD} sign-in here, so there is nothing to link.`}
        />
        <Exits />
      </>
    );
  }
  if (view.kind === "broken") {
    return (
      <>
        <Outcome
          icon={<AlertCircle aria-hidden className="h-10 w-10 text-warning" />}
          title="This link is broken"
          text="Start again from Settings › Security."
        />
        <Exits />
      </>
    );
  }
  return (
    <>
      <Outcome
        icon={<AlertCircle aria-hidden className="h-10 w-10 text-warning" />}
        title={`${CLOUD} is not linked`}
      />
      <ErrorNote message={REFUSAL[view.reason]} detail={view.detail} />
      {view.reason === "signed_out" ? (
        <Button
          as="a"
          href={`/login?return=${encodeURIComponent("/link-cloud")}`}
          size="sm"
          radius="md"
          color="primary"
          className="self-start"
        >
          Sign in
        </Button>
      ) : view.reason === "turned_off" ? null : (
        <Button
          as="a"
          href="/link-cloud"
          size="sm"
          radius="md"
          variant="flat"
          className="self-start"
        >
          Start again
        </Button>
      )}
      <Exits />
    </>
  );
}

function Outcome({
  icon,
  title,
  text,
  busy,
}: {
  icon: React.ReactNode;
  title: string;
  text?: string;
  busy?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!busy) heading.current?.focus();
  }, [busy, title]);
  return (
    <>
      {icon}
      <div className="flex flex-col gap-1.5" aria-busy={busy || undefined}>
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-heading text-[20px] font-medium text-foreground outline-none"
          role={busy ? "status" : undefined}
        >
          {title}
        </h1>
        {text ? (
          <p className="text-[13.5px] leading-relaxed text-foreground/65">
            {text}
          </p>
        ) : null}
      </div>
    </>
  );
}

function Exits() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      <a
        href="/settings/security"
        className="inline-flex min-h-10 items-center text-[13px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
      >
        Settings › Security
      </a>
      <a
        href="/"
        className="inline-flex min-h-10 items-center text-[13px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
      >
        Open this pod's console
      </a>
    </div>
  );
}
