"use client";

/**
 * The secure-access step (`/start/access`): the same "Ways to confirm it's
 * you" section as the person's Security page (`WaysInSection`), so each way
 * is added here, through its own door, without leaving onboarding. A sign-in
 * a door asks for brings the person back here.
 *
 * Continue only records that the owner went past the step
 * (`onboarding.recordStartStep`); with fewer than two ways in it reads "Skip
 * for now" and the top bar keeps asking. The pod sends them to the next step.
 */
import Link from "next/link";
import { useState } from "react";
import { Button } from "@heroui/react";
import { useT } from "../../../lib/i18n/locale-provider";
import {
  useAccountRecoveryStatus,
  WaysInSection,
} from "../../settings/security/SecurityView";
import { useWaysIn } from "../../_lib/presence/ways-in/use-ways-in";
import { accessContinue } from "./_lib/access-model";
import { en, fr } from "./_lib/copy";

const CATALOGS = { en, fr };
const HERE = "/start/access";

/** Record going past the step. Throws when the pod did not record it. */
async function recordAccessStep(): Promise<void> {
  const res = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "access" }),
  });
  if (!res.ok) throw new Error(`The pod answered ${res.status}.`);
}

export function AccessStepForm({ email }: { email: string | null }) {
  const t = useT(CATALOGS);
  const { status, loadStatus } = useAccountRecoveryStatus(HERE);
  const { state } = useWaysIn();
  const [pending, setPending] = useState(false);
  const [recordFailed, setRecordFailed] = useState(false);
  const action = accessContinue(state);

  const onContinue = async () => {
    setPending(true);
    setRecordFailed(false);
    try {
      await recordAccessStep();
    } catch {
      // A failed record is shown, never passed over: the step stays.
      setRecordFailed(true);
      setPending(false);
      return;
    }
    // The SERVER sends the person to the step the pod now says is next.
    window.location.assign("/start");
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-[13.5px] text-foreground/70">{t("lead")}</p>
      </div>

      <WaysInSection
        returnTo={HERE}
        status={status}
        onCodesChanged={loadStatus}
        email={email}
      />

      {recordFailed && (
        <p role="alert" className="text-[12.5px] text-status-down">
          {t("recordFailed")}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            color={action === "continue" ? "primary" : "default"}
            variant={action === "continue" ? "solid" : "flat"}
            radius="md"
            isDisabled={pending}
            isLoading={pending}
            onPress={() => void onContinue()}
          >
            {t(action)}
          </Button>
          <Button
            as={Link}
            href="/start?step=intent"
            variant="light"
            radius="md"
            isDisabled={pending}
          >
            {t("back")}
          </Button>
        </div>
        {action === "skip" && (
          <p className="text-[12px] text-foreground/60">{t("skipHint")}</p>
        )}
      </div>
    </>
  );
}
