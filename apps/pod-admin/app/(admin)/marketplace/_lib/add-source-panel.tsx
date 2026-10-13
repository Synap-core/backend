"use client";

/**
 * Marketplace › Sources › Add a source — three steps in one panel, in the
 * order a careful person checks a new software source (F-Droid style):
 *
 *   1. Where is it      — the address; the POD fetches and verifies the index
 *                         (`marketplace.sources.add`), nothing is stored.
 *   2. Who signs it     — the publisher's name and key fingerprint; the person
 *                         compares it with the one the publisher gave them.
 *   3. How far to trust — trusted or showcase only, each with what it means.
 *
 * Confirming (`marketplace.sources.confirm`) sends back the fingerprint the
 * person saw: the pod pins the key only if the source is STILL signed by it.
 * The server refuses every caller but a signed-in person who administers the
 * pod — this panel only reflects that.
 */

import {
  Button,
  Checkbox,
  Input,
  Radio,
  RadioGroup,
  Switch,
} from "@heroui/react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ADDABLE_TRUST_LEVELS,
  TRUST_CONSEQUENCE,
  formatKeyFingerprint,
  type AddableTrust,
} from "@synap-core/types/marketplace-source";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import { SectionCard } from "../../components/section-card";
import { trustLabel } from "./sources-model";
import type { SourcePreview } from "./types";

export function AddSourcePanel({
  onDone,
  onCancel,
}: {
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const utils = trpc.useUtils();
  const [address, setAddress] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);
  const [trust, setTrust] = useState<AddableTrust>("trusted");
  const [agentsMayPropose, setAgentsMayPropose] = useState(false);
  const inspect = trpc.marketplace.sources.add.useMutation();
  const confirm = trpc.marketplace.sources.confirm.useMutation();
  const panelRef = useRef<HTMLDivElement>(null);

  // The panel opens under the sources list, often below the fold on a phone.
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  async function fetchIndex() {
    setPreview(null);
    setKeyChecked(false);
    confirm.reset();
    try {
      const found = await inspect.mutateAsync({ url: address.trim() });
      setPreview(found);
      // An unsigned source can only ever be a showcase.
      setTrust(found.signed ? "trusted" : "showcase");
    } catch {
      // `inspect.error` carries the sentence shown under the field.
    }
  }

  async function add() {
    if (!preview) return;
    try {
      const added = await confirm.mutateAsync({
        url: preview.url,
        trust,
        keyFingerprint: preview.keyFingerprint,
        agentsMayPropose: trust === "trusted" && agentsMayPropose,
      });
      await Promise.all([
        utils.marketplace.sources.list.invalidate(),
        utils.marketplace.list.invalidate(),
      ]);
      onDone(added.id);
    } catch {
      // `confirm.error` is shown above the buttons.
    }
  }

  const fingerprint = formatKeyFingerprint(preview?.keyFingerprint);
  const canAdd =
    !!preview &&
    !preview.conflict &&
    (preview.signed ? keyChecked : trust === "showcase") &&
    !confirm.isPending;

  return (
    <SectionCard title="Add a source">
      <div ref={panelRef} className="flex scroll-mt-4 flex-col gap-5">
        {/* ── 1 · Where is it ─────────────────────────────────────── */}
        <Step label="1 · Where is it">
          {/* A form, so Enter in the address field fetches. */}
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              if (address.trim() && !inspect.isPending) void fetchIndex();
            }}
          >
            <Input
              autoFocus
              size="sm"
              radius="md"
              variant="bordered"
              label="Source address"
              placeholder="https://packages.example.com"
              value={address}
              onValueChange={(v) => {
                setAddress(v);
                setPreview(null);
                inspect.reset();
              }}
              isInvalid={!!inspect.error}
              errorMessage={
                inspect.error
                  ? (readableError(inspect.error.message) ??
                    "Couldn't read a source at that address. Check it and try again.")
                  : undefined
              }
              className="sm:max-w-md"
              autoComplete="off"
              spellCheck="false"
            />
            <Button
              type="submit"
              size="sm"
              radius="md"
              variant="flat"
              className="w-fit sm:mt-1.5"
              isLoading={inspect.isPending}
              isDisabled={!address.trim() || inspect.isPending}
            >
              Fetch
            </Button>
          </form>
        </Step>

        {preview && (
          <>
            {/* ── 2 · Check who signs it ─────────────────────────── */}
            <Step label="2 · Check who signs it">
              <div className="flex flex-col gap-3 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/10">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-[13px] font-medium text-foreground/70">
                    {preview.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {preview.name}
                    </p>
                    <p className="truncate text-[11.5px] text-foreground/65">
                      {preview.packageCount} package
                      {preview.packageCount === 1 ? "" : "s"} · id{" "}
                      <span className="font-mono">{preview.id}</span>
                    </p>
                  </div>
                </div>
                {preview.signed && fingerprint ? (
                  <>
                    <div>
                      <p className="text-[11.5px] text-foreground/65">
                        Signing key fingerprint
                      </p>
                      <p className="break-all font-mono text-[12.5px] text-foreground">
                        ed25519 · {fingerprint}
                      </p>
                    </div>
                    <Checkbox
                      size="sm"
                      isSelected={keyChecked}
                      onValueChange={setKeyChecked}
                    >
                      <span className="text-[12.5px] text-foreground">
                        This key matches the one the publisher gave me.
                      </span>
                    </Checkbox>
                    <p className="text-[11.5px] leading-relaxed text-foreground/65">
                      Compare it with the fingerprint the publisher gave you.
                      Future updates must be signed by this same key — if it
                      changes, this pod stops installing from the source until
                      you approve the new one.
                    </p>
                  </>
                ) : (
                  <p className="text-[12.5px] leading-relaxed text-foreground/70">
                    This source isn&apos;t signed, so it can only be a showcase:
                    its packages are listed, and nothing from it runs here.
                  </p>
                )}
                {preview.conflict && (
                  <p className="flex items-start gap-1.5 text-[12px] text-status-down">
                    <CircleAlert size={13} className="mt-0.5 shrink-0" />
                    {preview.conflict}
                  </p>
                )}
              </div>
            </Step>

            {/* ── 3 · How much to trust it ───────────────────────── */}
            <Step label="3 · How much to trust it">
              <RadioGroup
                size="sm"
                aria-label="Trust level"
                value={trust}
                onValueChange={(v) => setTrust(v as AddableTrust)}
              >
                {ADDABLE_TRUST_LEVELS.map((level) => (
                  <Radio
                    key={level}
                    value={level}
                    isDisabled={level === "trusted" && !preview.signed}
                    description={TRUST_CONSEQUENCE[level]}
                  >
                    {trustLabel(level)}
                  </Radio>
                ))}
              </RadioGroup>
              {trust === "trusted" && (
                <Switch
                  size="sm"
                  className="mt-3"
                  isSelected={agentsMayPropose}
                  onValueChange={setAgentsMayPropose}
                >
                  <span className="text-[12.5px] text-foreground">
                    Let agents propose installs from it — you still approve each
                    one in Review
                  </span>
                </Switch>
              )}
            </Step>
          </>
        )}

        <p className="flex items-start gap-2 rounded-lg bg-status-stale/10 p-3 text-[12px] leading-relaxed text-foreground/75">
          <TriangleAlert
            size={14}
            className="mt-0.5 shrink-0 text-status-stale"
          />
          <span>
            Packages from sources other than Synap can run code and reach the
            network. Only add publishers you would install software from.
          </span>
        </p>

        {confirm.error && (
          <ErrorNote
            message={
              readableError(confirm.error.message) ??
              "The source wasn't added. Nothing changed — try again."
            }
            detail={errorDetail(confirm.error)}
          />
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-foreground/[0.07] pt-3">
          <Button
            size="sm"
            radius="md"
            color="primary"
            isDisabled={!canAdd}
            isLoading={confirm.isPending}
            onPress={() => void add()}
          >
            {/* Neutral until the pod has read the source: before that, nobody
                knows whether it is signed. */}
            {!preview
              ? "Add source"
              : preview.signed
                ? "Trust key and add source"
                : "Add as showcase"}
          </Button>
          <Button
            size="sm"
            radius="md"
            variant="light"
            isDisabled={confirm.isPending}
            onPress={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/65">
        {label}
      </p>
      {children}
    </div>
  );
}
