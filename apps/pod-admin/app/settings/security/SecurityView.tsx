"use client";

/**
 * Security — your sign-in methods and your way back in, for THIS pod.
 *
 *   1. Recovery codes — the pod-held way back in (shown once, copy/download).
 *   2. Password — the Kratos settings flow's password group.
 *   3. Signed-in devices — your other sessions; "Sign out other devices".
 *   4. Synap Cloud — what Cloud may do here (owner only; OMITTED when Cloud
 *      sign-in is not wired on this pod).
 *
 * Passkeys are not here yet: the shared ceremony lives in synap-app's
 * `@synap-core/auth-ui`, which this app does not depend on (wave 2).
 *
 * Every refusal is shown as what it is: a sign-in that is too old
 * (`reauth_required` → "Sign in again"), a Cloud-only session that may not
 * change credentials (founder decision R1), or a failed read (LoadFailed).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Chip, Radio, RadioGroup, addToast } from "@heroui/react";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  KeyRound,
  Laptop,
  Lock,
} from "lucide-react";
import {
  CLOUD_TRUST_OPTIONS,
  type AccountRecoveryStatus,
  type CloudTrustMode,
  type GeneratedRecoveryCodes,
} from "@synap-core/types/account-recovery";
import { SectionCard } from "../../(admin)/components/section-card";
import { StatusPill } from "../../(admin)/components/status-pill";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import {
  createBrowserFlow,
  fetchFlow,
  listOtherSessions,
  revokeOtherSessions,
  submitSelfServiceFlow,
  type KratosFlow,
} from "../../../lib/kratos-flow";
import {
  recoveryApi,
  recoveryCodesFile,
  type RecoveryCall,
} from "../../../lib/account-recovery";
import { publicPodUrl } from "../../../lib/public-pod-url";
import { initialFieldValues, KratosFields } from "../../_lib/kratos-fields";

const REAUTH_HREF = `/login?refresh=1&return=${encodeURIComponent("/settings/security")}`;
/** Kratos v1.3.1 `text.NewRecoverySuccessful` (InfoSelfServiceSettingsRecoverySuccessful). */
const KRATOS_RECOVERY_SUCCESSFUL = 1060001;
const PASSWORD_GROUPS = ["password"] as const;

type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; data: T };

export function SecurityView({
  initialFlowId,
  email,
}: {
  initialFlowId: string | null;
  email: string | null;
}) {
  const [status, setStatus] = useState<Load<AccountRecoveryStatus>>({ kind: "loading" });
  const [recovered, setRecovered] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatus({ kind: "loading" });
    const r = await recoveryApi.status();
    if (!r.ok && r.status === 401) {
      window.location.assign(`/login?return=${encodeURIComponent("/settings/security")}`);
      return;
    }
    setStatus(r.ok ? { kind: "ready", data: r.data } : { kind: "failed", message: r.message });
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const s = status.kind === "ready" ? status.data : null;

  return (
    <div className="mx-auto max-w-[760px] px-6 py-10">
      <header className="mb-6 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            Security
          </h1>
          {s?.session.cloudOnly ? (
            <Chip size="sm" radius="sm" variant="flat" startContent={<Cloud className="ml-1 h-3 w-3" />}>
              Signed in with Synap Cloud
            </Chip>
          ) : null}
        </div>
        <p className="text-[13px] text-foreground/60">
          How {email ?? "you"} sign{email ? "s" : ""} in to this pod, and how to get back in.
        </p>
      </header>

      {recovered ? (
        <div
          className="mb-5 flex items-start gap-2 rounded-medium bg-success/10 p-3 text-[13px] text-foreground/85 ring-1 ring-inset ring-success/30"
          role="status"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span>Account recovered. Set a new password now — this window closes in 15 minutes.</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        <RecoveryCodesCard status={status} onChanged={loadStatus} email={email} />
        <PasswordCard initialFlowId={initialFlowId} onRecovered={() => setRecovered(true)} />
        <DevicesCard />
        {s && s.cloud.available ? (
          <CloudTrustCard status={s} onChanged={(next) => setStatus({ kind: "ready", data: next })} />
        ) : null}
      </div>
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="flex items-start gap-2 text-[12.5px] text-status-down">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {message}
      </p>
      <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A refusal the reader can act on: sign in again, or (Cloud-only) use the pod's own sign-in. */
function Refusal({ error, message }: { error: string; message: string }) {
  const reauth = error === "reauth_required" || error === "cloud_session_not_allowed";
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-medium bg-warning/10 p-3 text-[13px] text-foreground/80 ring-1 ring-inset ring-warning/30"
      role="status"
    >
      <span className="flex items-start gap-2">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        {message}
      </span>
      {reauth ? (
        <Button as="a" href={REAUTH_HREF} size="sm" variant="flat" radius="md">
          {error === "reauth_required" ? "Sign in again" : "Sign in with your pod password"}
        </Button>
      ) : null}
    </div>
  );
}

function refusalOf(r: RecoveryCall<unknown>) {
  return r.ok ? null : { error: r.error, message: r.message };
}

// ─── 1. Recovery codes ───────────────────────────────────────────────────

function RecoveryCodesCard({
  status,
  onChanged,
  email,
}: {
  status: Load<AccountRecoveryStatus>;
  onChanged: () => Promise<void>;
  email: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [refusal, setRefusal] = useState<{ error: string; message: string } | null>(null);
  const [fresh, setFresh] = useState<GeneratedRecoveryCodes | null>(null);

  const generate = async () => {
    setBusy(true);
    setRefusal(null);
    const r = await recoveryApi.generateCodes();
    setBusy(false);
    setConfirm(false);
    if (r.ok) setFresh(r.data);
    else setRefusal(refusalOf(r));
  };

  const codes = status.kind === "ready" ? status.data.recoveryCodes : null;
  const mark = !codes
    ? null
    : !codes.set
      ? { kind: "stale" as const, label: "Not set" }
      : codes.remaining <= 2
        ? { kind: "stale" as const, label: `${codes.remaining} left` }
        : { kind: "healthy" as const, label: `${codes.remaining} of ${codes.total} left` };

  return (
    <div id="recovery-codes">
      <SectionCard
        title="Recovery codes"
        hint="One-time codes that get you back in without email, Synap Cloud or the server"
        actions={mark ? <StatusPill kind={mark.kind} label={mark.label} /> : undefined}
      >
        {status.kind === "loading" ? (
          <div className="h-10 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
        ) : status.kind === "failed" ? (
          <LoadFailed message={`Couldn't load your recovery status. ${status.message}`} onRetry={() => void onChanged()} />
        ) : fresh ? (
          <CodesReveal
            codes={fresh}
            email={email}
            onDone={() => {
              setFresh(null);
              void onChanged();
            }}
          />
        ) : (
          <div className="flex flex-col items-start gap-3">
            {refusal ? <Refusal {...refusal} /> : null}
            {codes?.set ? (
              <Button size="sm" variant="flat" radius="md" isLoading={busy} onPress={() => setConfirm(true)}>
                Create new codes
              </Button>
            ) : (
              <Button color="primary" radius="md" size="md" startContent={<KeyRound className="h-4 w-4" />} isLoading={busy} onPress={() => void generate()}>
                Create recovery codes
              </Button>
            )}
          </div>
        )}
      </SectionCard>
      <ConfirmModal
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void generate()}
        title="Create new recovery codes?"
        consequence={<p>Your current codes stop working right away. Save the new ones before you leave this page.</p>}
        confirmLabel="Create new codes"
        isPending={busy}
      />
    </div>
  );
}

function CodesReveal({
  codes,
  email,
  onDone,
}: {
  codes: GeneratedRecoveryCodes;
  email: string | null;
  onDone: () => void;
}) {
  const file = recoveryCodesFile({
    codes: codes.codes,
    podUrl: publicPodUrl() ?? window.location.origin,
    email,
    createdAt: codes.createdAt,
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.codes.join("\n"));
      addToast({ title: "Codes copied", color: "default" });
    } catch {
      addToast({ title: "Couldn't copy — select them instead", color: "danger" });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([file], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "synap-pod-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-[12.5px] text-foreground/70">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        Shown once. Keep them somewhere other than this device — each works one time.
      </p>
      <ol className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-medium bg-foreground/[0.04] p-4 font-mono text-[13px] text-foreground sm:grid-cols-2">
        {codes.codes.map((c) => (
          <li key={c} className="select-all tracking-wide">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="flat" radius="md" startContent={<Copy className="h-3.5 w-3.5" />} onPress={() => void copy()}>
          Copy
        </Button>
        <Button size="sm" variant="flat" radius="md" startContent={<Download className="h-3.5 w-3.5" />} onPress={download}>
          Download
        </Button>
        <Button size="sm" color="primary" radius="md" className="ml-auto" onPress={onDone}>
          I&apos;ve saved them
        </Button>
      </div>
    </div>
  );
}

// ─── 2. Password ─────────────────────────────────────────────────────────

type FlowLoad =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; flow: KratosFlow };

function PasswordCard({
  initialFlowId,
  onRecovered,
}: {
  initialFlowId: string | null;
  onRecovered: () => void;
}) {
  const [load, setLoad] = useState<FlowLoad>({ kind: "loading" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  const show = useCallback((flow: KratosFlow) => {
    setLoad({ kind: "ready", flow });
    setValues(initialFieldValues(flow, PASSWORD_GROUPS));
    const errors = (flow.ui.messages ?? []).filter((m) => m.type === "error").map((m) => m.text);
    setError(errors.length ? errors.join(" ") : null);
  }, []);

  const start = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      if (initialFlowId) {
        const flow = await fetchFlow("settings", initialFlowId);
        if ((flow.ui.messages ?? []).some((m) => m.id === KRATOS_RECOVERY_SUCCESSFUL)) onRecovered();
        show(flow);
        return;
      }
      const r = await createBrowserFlow("settings");
      if ("flow" in r) show(r.flow);
      else window.location.assign(`/login?return=${encodeURIComponent("/settings/security")}`);
    } catch (err) {
      setLoad({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't load password settings." });
    }
  }, [initialFlowId, onRecovered, show]);

  useEffect(() => {
    void start();
  }, [start]);

  const submit = async (body: Record<string, string>) => {
    if (load.kind !== "ready") return;
    setSubmitting(true);
    setError(null);
    setNeedsReauth(false);
    try {
      const r = await submitSelfServiceFlow(load.flow, body);
      if (r.kind === "refresh_required") setNeedsReauth(true);
      else if (r.kind === "flow") {
        show(r.flow);
        if (r.flow.state === "success") {
          setValues((prev) => ({ ...prev, password: "" }));
          addToast({ title: "Password saved", color: "default" });
        }
      } else if (r.kind === "redirect") window.location.assign(r.to);
      else if (r.kind === "error") setError(r.error.message ?? "Couldn't save the password.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the password.");
    } finally {
      setSubmitting(false);
    }
  };

  const hasPasswordNode =
    load.kind === "ready" && load.flow.ui.nodes.some((n) => n.group === "password");

  return (
    <SectionCard title="Password" hint="Your password for this pod">
      {load.kind === "loading" ? (
        <div className="h-24 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
      ) : load.kind === "failed" ? (
        <LoadFailed message={load.message} onRetry={() => void start()} />
      ) : !hasPasswordNode ? (
        <p className="text-[12.5px] text-foreground/55">Passwords aren&apos;t enabled on this pod.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {needsReauth ? (
            <Refusal error="reauth_required" message="Changing your password needs a recent sign-in." />
          ) : null}
          <KratosFields
            flow={load.flow}
            groups={PASSWORD_GROUPS}
            values={values}
            setValues={setValues}
            onSubmit={(b) => void submit(b)}
            submitting={submitting}
            submitLabel="Save password"
            error={error}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ─── 3. Devices ──────────────────────────────────────────────────────────

function DevicesCard() {
  const [load, setLoad] = useState<Load<number>>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", data: (await listOtherSessions()).length });
    } catch (err) {
      setLoad({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't list your devices." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOutOthers = async () => {
    setBusy(true);
    try {
      const n = await revokeOtherSessions();
      addToast({ title: n === 1 ? "Signed out 1 device" : `Signed out ${n} devices`, color: "default" });
      await refresh();
    } catch (err) {
      addToast({ title: "Couldn't sign out other devices", description: err instanceof Error ? err.message : undefined, color: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Signed-in devices" hint="Browsers and apps signed in to your account">
      {load.kind === "loading" ? (
        <div className="h-10 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
      ) : load.kind === "failed" ? (
        <LoadFailed message={load.message} onRetry={() => void refresh()} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Laptop className="h-4 w-4 text-foreground/50" />
          <span className="flex-1 text-[13px] text-foreground/80">
            {load.data === 0 ? "Only this device" : `This device and ${load.data} other${load.data === 1 ? "" : "s"}`}
          </span>
          {load.data > 0 ? (
            <Button size="sm" variant="flat" radius="md" isLoading={busy} onPress={() => void signOutOthers()}>
              Sign out other devices
            </Button>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ─── 4. Synap Cloud trust ────────────────────────────────────────────────

function CloudTrustCard({
  status,
  onChanged,
}: {
  status: AccountRecoveryStatus;
  onChanged: (next: AccountRecoveryStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ error: string; message: string } | null>(null);
  const current = status.cloud.trust;
  const currentOption = CLOUD_TRUST_OPTIONS.find((o) => o.mode === current)!;

  const change = async (mode: CloudTrustMode) => {
    if (mode === current) return;
    setBusy(true);
    setRefusal(null);
    const r = await recoveryApi.setCloudTrust(mode);
    setBusy(false);
    if (r.ok) {
      onChanged(r.data);
      addToast({ title: "Synap Cloud access updated", color: "default" });
    } else setRefusal(refusalOf(r));
  };

  return (
    <SectionCard
      title="Synap Cloud"
      hint="What Synap Cloud may do on this pod"
      actions={
        <StatusPill
          kind={current === "sign_in_recovery" ? "stale" : current === "off" ? "unknown" : "healthy"}
          label={currentOption.label}
        />
      }
    >
      {status.cloud.canEdit ? (
        <div className="flex flex-col gap-3">
          {refusal ? <Refusal {...refusal} /> : null}
          <RadioGroup
            aria-label="Synap Cloud access"
            value={current}
            isDisabled={busy}
            onValueChange={(v) => void change(v as CloudTrustMode)}
          >
            {CLOUD_TRUST_OPTIONS.map((o) => (
              <Radio key={o.mode} value={o.mode} description={o.detail}>
                {o.label}
              </Radio>
            ))}
          </RadioGroup>
        </div>
      ) : (
        <p className="text-[12.5px] text-foreground/65">
          {currentOption.detail} Only the pod owner can change this.
        </p>
      )}
    </SectionCard>
  );
}
