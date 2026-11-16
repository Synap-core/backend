"use client";

/**
 * The SHORT consent (plan 647ebfd4 option C, founder 16 Nov 2026): a pod app
 * already connected asks for ONE MORE thing (`synap_ask`), "Content Studio
 * asks to read notes in Content OS". Only those pairs, one Allow; allowing
 * ADDS them to what the app holds, nothing it holds is shown or changed here.
 * Taking access back stays on the app's page ("See everything it has").
 *
 * Every word naming a permission or a space comes from the server's ask
 * (`getOAuthConsentContext().app.ask`) through the one summary door
 * (`summarizeAppConnectRequest`), never written here.
 */

import Link from "next/link";
import { Button } from "@heroui/react";
import { Check } from "lucide-react";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import type { Step } from "./ConsentForm";

export interface ConsentAsk {
  title: string;
  pairs: Array<{
    permission: string;
    workspaceId: string;
    workspaceName: string;
  }>;
  unavailable: string[];
  connectionPublicId: string | null;
}

export function AskConsent({
  appName,
  ask,
  busy,
  step,
  onDecide,
}: {
  appName: string;
  ask: ConsentAsk;
  busy: boolean;
  step: Step;
  onDecide: (approve: boolean) => void;
}) {
  const lines = summarizeAppConnectRequest({
    appName,
    requests: ask.pairs,
    mode: "add",
  }).lines;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        <p className="text-xs font-medium uppercase tracking-[0.04em] text-foreground/65">
          Also allow
        </p>
        <ul className="flex flex-col gap-2">
          {lines.map((line) => (
            <li
              key={line.workspaceId ?? line.where}
              className="flex items-start gap-2"
            >
              <Check
                className="mt-[3px] h-3 w-3 shrink-0 text-primary"
                aria-hidden
                strokeWidth={2.4}
              />
              <span className="text-sm leading-relaxed text-foreground/85">
                {line.text}
              </span>
            </li>
          ))}
        </ul>
        {ask.unavailable.length > 0 ? (
          <p className="text-xs leading-relaxed text-foreground/65">
            It also asked for something none of your spaces can hold; that part
            is left out.
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-foreground/65">
          What it already has stays as it is.
        </p>
      </div>

      <div className="flex gap-2.5">
        <Button
          color="primary"
          radius="md"
          size="md"
          className="flex-1 font-medium"
          isDisabled={busy}
          isLoading={busy && step.kind === "working" && step.approve}
          onPress={() => onDecide(true)}
        >
          Allow
        </Button>
        <Button
          variant="flat"
          radius="md"
          size="md"
          className="flex-1"
          isDisabled={busy}
          isLoading={busy && step.kind === "working" && !step.approve}
          onPress={() => onDecide(false)}
        >
          Not now
        </Button>
      </div>

      {ask.connectionPublicId ? (
        <p className="text-center text-xs leading-relaxed text-foreground/65">
          <Link
            href={`/apps/${encodeURIComponent(ask.connectionPublicId)}`}
            className="text-foreground/65 underline underline-offset-2"
          >
            See everything it has
          </Link>
        </p>
      ) : null}
    </div>
  );
}
