"use client";

/**
 * Marketplace › Sources — where the Catalog comes from.
 *
 * Synap's catalog is built in (it can be turned off, never removed); anything
 * else is a source a pod admin added, with the trust they chose and the key
 * they confirmed. A source signed by a NEW key is blocked until someone here
 * compares the fingerprint and re-approves it — that is the one thing this
 * page must make impossible to miss, so it is the row's action.
 *
 * Every change is the pod's decision to refuse or accept: an agent or a key
 * can never add or change a source (server-enforced in
 * `marketplace.sources.*`); this page only reflects it. `?focus=<id>`
 * highlights a source.
 */

import {
  Button,
  Chip,
  Radio,
  RadioGroup,
  Switch,
  addToast,
} from "@heroui/react";
import { Check, Eye, Globe, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ADDABLE_TRUST_LEVELS,
  PRIVATE_CAPABILITY_TRUST_LINE,
  TRUST_CONSEQUENCE,
  formatKeyFingerprint,
  type AddableTrust,
} from "@synap-core/types/marketplace-source";
import { trpc } from "../../../../lib/trpc";
import { formatDate, readableError } from "../../../../lib/format";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import { AdvancedPanel } from "../../../_lib/object/advanced-panel";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { ConfirmModal } from "../../components/confirm-modal";
import { DetailDrawer } from "../../components/detail-drawer";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { useFocusRow } from "../../components/use-focus-row";
import { AddSourcePanel } from "./add-source-panel";
import {
  packageCountLabel,
  signingLine,
  sourceFacts,
  sourceHost,
  sourcePill,
  sourceRowAction,
  trustConsequenceLine,
  trustLabel,
} from "./sources-model";
import type { MarketSource } from "./types";

export function SourcesTab() {
  const sources = trpc.marketplace.sources.list.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<MarketSource | null>(null);

  useEffect(() => {
    if (sources.error) redirectToLoginIfUnauthorized(sources.error);
  }, [sources.error]);
  useFocusRow({ ready: !sources.isLoading });

  const list = sources.data ?? [];
  const open = list.find((s) => s.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title="Sources"
        hint="Where the Catalog comes from"
        actions={
          !adding ? (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              startContent={<Plus size={14} />}
              onPress={() => setAdding(true)}
            >
              Add a source
            </Button>
          ) : undefined
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {sources.isLoading ? (
            <ResourceRowSkeleton count={2} />
          ) : sources.isError ? (
            <ResourceRowError
              message="Couldn't load the sources."
              onRetry={() => void sources.refetch()}
            />
          ) : list.length === 0 ? (
            <ResourceRowEmpty message="No catalog source on this pod." />
          ) : (
            list.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                onOpen={() => setOpenId(source.id)}
                onReviewKey={() => setReviewing(source)}
              />
            ))
          )}
        </div>
      </SectionCard>

      {adding && (
        <AddSourcePanel
          onCancel={() => setAdding(false)}
          onDone={(id) => {
            setAdding(false);
            addToast({ title: "Source added", color: "success" });
            setOpenId(id);
          }}
        />
      )}

      <SourceDrawer
        source={open}
        onClose={() => setOpenId(null)}
        onReviewKey={(s) => setReviewing(s)}
      />
      <KeyReviewModal source={reviewing} onClose={() => setReviewing(null)} />
    </div>
  );
}

function SourceRow({
  source,
  onOpen,
  onReviewKey,
}: {
  source: MarketSource;
  onOpen: () => void;
  onReviewKey: () => void;
}) {
  const utils = trpc.useUtils();
  const sync = trpc.marketplace.sources.syncNow.useMutation({
    // A sync can add, change or drop packages — the Catalog reads them too.
    onSettled: () =>
      void Promise.all([
        utils.marketplace.sources.list.invalidate(),
        utils.marketplace.list.invalidate(),
      ]),
    onError: (err) =>
      addToast({
        title: "Sync didn't run",
        description: readableError(err.message) ?? "Try again in a minute.",
        color: "danger",
      }),
  });
  const toggle = trpc.marketplace.sources.disable.useMutation({
    onSettled: () =>
      void Promise.all([
        utils.marketplace.sources.list.invalidate(),
        utils.marketplace.list.invalidate(),
      ]),
    onError: (err) =>
      addToast({
        title: "Couldn't turn it on",
        description:
          readableError(err.message) ?? "Nothing changed — try again.",
        color: "danger",
      }),
  });
  const action = sourceRowAction(source);
  const signing = signingLine(source);
  const Icon = source.official ? ShieldCheck : Globe;

  return (
    <div data-row-id={source.id} className="rounded-md">
      <ResourceRow
        Icon={Icon}
        primary={source.name}
        secondary={sourceFacts(source).join(" · ")}
        status={sourcePill(source)}
        onSelect={onOpen}
        wrap
        actions={
          action === "review_key" ? (
            <Button
              size="sm"
              radius="md"
              color="danger"
              variant="flat"
              onPress={onReviewKey}
            >
              Review new key
            </Button>
          ) : action === "turn_on" ? (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              isLoading={toggle.isPending}
              onPress={() => toggle.mutate({ id: source.id, enabled: true })}
            >
              Turn on
            </Button>
          ) : action === "sync" ? (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              isLoading={sync.isPending}
              onPress={() => sync.mutate({ id: source.id })}
            >
              Sync now
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 pl-10">
        <TrustChip trust={source.trust} />
        <span
          className={`min-w-0 break-all text-[11.5px] text-foreground/65 ${signing.mono ? "font-mono" : ""}`}
        >
          {signing.text}
        </span>
      </div>
    </div>
  );
}

const TRUST_ICON = {
  official: ShieldCheck,
  trusted: Check,
  showcase: Eye,
} as const;

/**
 * How far this pod trusts a source — a neutral fact chip (like the Apps
 * page's `ViaChip`), never a status colour: "Trusted" is a choice the admin
 * made, not a health signal.
 */
export function TrustChip({ trust }: { trust: MarketSource["trust"] }) {
  const Icon = TRUST_ICON[trust];
  return (
    <Chip
      size="sm"
      radius="sm"
      variant="flat"
      className="bg-foreground/[0.05] text-[11px] text-foreground/75 ring-1 ring-inset ring-foreground/10"
      startContent={<Icon className="ml-1 h-3 w-3" aria-hidden />}
    >
      {trustLabel(trust)}
    </Chip>
  );
}

function SourceDrawer({
  source,
  onClose,
  onReviewKey,
}: {
  source: MarketSource | null;
  onClose: () => void;
  onReviewKey: (source: MarketSource) => void;
}) {
  const utils = trpc.useUtils();
  const [removing, setRemoving] = useState(false);
  const refresh = () =>
    Promise.all([
      utils.marketplace.sources.list.invalidate(),
      utils.marketplace.list.invalidate(),
    ]);
  const update = trpc.marketplace.sources.update.useMutation({
    onSettled: () => void refresh(),
  });
  const toggle = trpc.marketplace.sources.disable.useMutation({
    onSettled: () => void refresh(),
  });
  const remove = trpc.marketplace.sources.remove.useMutation({
    onSuccess: () => {
      setRemoving(false);
      onClose();
      addToast({ title: "Source removed", color: "success" });
    },
    onSettled: () => void refresh(),
  });

  if (!source) return null;
  const signing = signingLine(source);
  const error = update.error ?? toggle.error;

  return (
    <>
      <DetailDrawer
        isOpen={!!source}
        onClose={onClose}
        title={source.name}
        subtitle={sourceHost(source.url)}
        headerRight={<TrustChip trust={source.trust} />}
        footer={
          source.official ? undefined : (
            <Button
              size="sm"
              radius="md"
              color="danger"
              variant="light"
              onPress={() => setRemoving(true)}
            >
              Remove source
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-5 text-[12.5px]">
          <p className="leading-relaxed text-foreground/70">
            {trustConsequenceLine(source)}
          </p>

          {source.blocked && (
            <p className="rounded-lg bg-status-down/10 p-3 leading-relaxed text-foreground/80">
              {source.blocked}
            </p>
          )}
          {source.state === "key_changed" && source.pendingFingerprint && (
            <Button
              size="sm"
              radius="md"
              color="danger"
              variant="flat"
              className="w-fit"
              onPress={() => onReviewKey(source)}
            >
              Review new key
            </Button>
          )}
          {source.message && (
            <p className="leading-relaxed text-foreground/65">
              {source.message}
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-foreground/65">Listed</dt>
            <dd>{packageCountLabel(source)}</dd>
            <dt className="text-foreground/65">Signed by</dt>
            <dd
              className={`break-all ${signing.mono ? "font-mono text-[11.5px]" : ""}`}
            >
              {signing.text}
            </dd>
            {source.addedAt && (
              <>
                <dt className="text-foreground/65">Added</dt>
                <dd>{formatDate(source.addedAt)}</dd>
              </>
            )}
          </dl>
          {source.official && (
            <p className="leading-relaxed text-foreground/65">
              {PRIVATE_CAPABILITY_TRUST_LINE}
            </p>
          )}

          {source.official ? (
            <div className="flex flex-col gap-1.5">
              <Switch
                size="sm"
                isSelected={source.enabled}
                isDisabled={source.lockedOff || toggle.isPending}
                onValueChange={(enabled) =>
                  toggle.mutate({ id: source.id, enabled })
                }
              >
                <span className="text-[12.5px]">Use Synap&apos;s catalog</span>
              </Switch>
              <p className="text-[11.5px] leading-relaxed text-foreground/65">
                {source.lockedOff
                  ? "Turned off by whoever runs this server, so it can't be turned on here."
                  : "Built in — it can be turned off, never removed. What you installed from it stays."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Switch
                size="sm"
                isSelected={source.enabled}
                isDisabled={toggle.isPending}
                onValueChange={(enabled) =>
                  toggle.mutate({ id: source.id, enabled })
                }
              >
                <span className="text-[12.5px]">Use this source</span>
              </Switch>
              <RadioGroup
                size="sm"
                label="How much to trust it"
                value={source.trust}
                isDisabled={update.isPending}
                onValueChange={(v) =>
                  update.mutate({ id: source.id, trust: v as AddableTrust })
                }
              >
                {ADDABLE_TRUST_LEVELS.map((level) => (
                  <Radio
                    key={level}
                    value={level}
                    isDisabled={level === "trusted" && !source.keyFingerprint}
                    description={TRUST_CONSEQUENCE[level]}
                  >
                    {trustLabel(level)}
                  </Radio>
                ))}
              </RadioGroup>
              {source.trust === "trusted" && (
                <Switch
                  size="sm"
                  isSelected={source.agentsMayPropose}
                  isDisabled={update.isPending}
                  onValueChange={(agentsMayPropose) =>
                    update.mutate({ id: source.id, agentsMayPropose })
                  }
                >
                  <span className="text-[12.5px]">
                    Agents may propose installs (you approve each in Review)
                  </span>
                </Switch>
              )}
            </div>
          )}
          {error && (
            <ErrorNote
              message={
                readableError(error.message) ??
                "That change didn't save. Nothing changed — try again."
              }
              detail={errorDetail(error)}
            />
          )}
          <AdvancedPanel
            ids={[
              { label: "Source id", value: source.id },
              { label: "Address", value: source.url },
            ]}
            explanation={
              source.lockedOff ? (
                <>
                  Turned off with{" "}
                  <span className="font-mono">SYNAP_CATALOG_SOURCE=off</span> in
                  the server&apos;s settings.
                </>
              ) : undefined
            }
          />
        </div>
      </DetailDrawer>

      <ConfirmModal
        isOpen={removing}
        onClose={() => setRemoving(false)}
        onConfirm={() => remove.mutate({ id: source.id })}
        title={`Remove ${source.name}?`}
        consequence={
          <>
            Its {packageCountLabel(source)} leave the Catalog and this pod
            forgets its key. What you already installed from it stays, and no
            longer gets updates from it.
            {remove.error && (
              <div className="mt-3">
                <ErrorNote
                  message={
                    readableError(remove.error.message) ??
                    "Couldn't remove it. Nothing changed — try again."
                  }
                  detail={errorDetail(remove.error)}
                />
              </div>
            )}
          </>
        }
        confirmLabel="Remove source"
        isPending={remove.isPending}
      />
    </>
  );
}

/**
 * A source now signed by a different key. The person compares the NEW
 * fingerprint with the one the publisher announced; approving sends the
 * fingerprint they saw, and the pod pins it only if the source is still
 * signed by exactly that key.
 */
function KeyReviewModal({
  source,
  onClose,
}: {
  source: MarketSource | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const approve = trpc.marketplace.sources.approveKeyChange.useMutation({
    onSuccess: () => {
      onClose();
      addToast({ title: "New key trusted", color: "success" });
    },
    onSettled: () =>
      void Promise.all([
        utils.marketplace.sources.list.invalidate(),
        utils.marketplace.list.invalidate(),
      ]),
  });
  const previous = formatKeyFingerprint(source?.keyFingerprint);
  const next = formatKeyFingerprint(source?.pendingFingerprint);

  return (
    <ConfirmModal
      isOpen={!!source}
      onClose={onClose}
      onConfirm={() =>
        source?.pendingFingerprint &&
        approve.mutate({
          id: source.id,
          keyFingerprint: source.pendingFingerprint,
        })
      }
      title={`${source?.name ?? "This source"} has a new signing key`}
      consequence={
        <div className="flex flex-col gap-3">
          <p>
            Nothing installs from it until you approve the new key. Compare it
            with the fingerprint the publisher announced — if they did not
            announce a change, do not approve it.
          </p>
          <div>
            <p className="text-[11.5px]">Trusted until now</p>
            <p className="break-all font-mono text-[12px] text-foreground/80">
              {previous ? `ed25519 · ${previous}` : "—"}
            </p>
          </div>
          <div>
            <p className="text-[11.5px]">Signed with now</p>
            <p className="break-all font-mono text-[12px] text-foreground">
              {next ? `ed25519 · ${next}` : "—"}
            </p>
          </div>
          {approve.error && (
            <ErrorNote
              message={
                readableError(approve.error.message) ??
                "The new key wasn't trusted. Nothing changed — try again."
              }
              detail={errorDetail(approve.error)}
            />
          )}
        </div>
      }
      confirmLabel="Trust the new key"
      confirmColor="warning"
      isConfirmDisabled={!source?.pendingFingerprint}
      isPending={approve.isPending}
    />
  );
}
