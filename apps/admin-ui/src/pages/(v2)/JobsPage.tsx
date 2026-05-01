import { useState, useMemo } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  Modal,
  Spinner,
  Tabs,
  Text,
  cn,
  useOverlayState,
} from "@heroui/react";
import {
  IconRefresh,
  IconBolt,
  IconClock,
  IconCircleCheck,
  IconCircleX,
  IconPlayerPause,
  IconArrowBack,
  IconX,
  IconHourglass,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { spacing } from "../../theme/tokens";

type JobState =
  | "created"
  | "retry"
  | "active"
  | "completed"
  | "cancelled"
  | "failed";

const STATE_CONFIG: Record<
  JobState,
  {
    label: string;
    color:
      | "default"
      | "primary"
      | "success"
      | "warning"
      | "danger"
      | "secondary";
    icon: typeof IconBolt;
  }
> = {
  created: { label: "Queued", color: "default", icon: IconClock },
  retry: { label: "Retry", color: "warning", icon: IconHourglass },
  active: { label: "Running", color: "primary", icon: IconBolt },
  completed: { label: "Completed", color: "success", icon: IconCircleCheck },
  cancelled: { label: "Cancelled", color: "secondary", icon: IconPlayerPause },
  failed: { label: "Failed", color: "danger", icon: IconCircleX },
};

const STATE_ORDER: JobState[] = [
  "active",
  "created",
  "retry",
  "failed",
  "completed",
  "cancelled",
];

function timeSince(date: Date | string | null) {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function duration(start: Date | string | null, end: Date | string | null) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 6) / 10;
  return `${min}m`;
}

export default function JobsPage() {
  const [stateFilter, setStateFilter] = useState<JobState | "all">("all");
  const [queueSearch, setQueueSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const detailsModal = useOverlayState({
    isOpen: !!selectedId,
    onOpenChange: (open) => {
      if (!open) setSelectedId(null);
    },
  });

  const statsQuery = trpc.system.getQueueStats.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const listQuery = trpc.system.listJobs.useQuery(
    {
      state: stateFilter === "all" ? undefined : stateFilter,
      queueName: queueSearch.trim() || undefined,
      limit: 100,
    },
    { refetchInterval: 30_000 }
  );

  const detailsQuery = trpc.system.getJobDetails.useQuery(
    { id: selectedId! },
    { enabled: !!selectedId }
  );

  const utils = trpc.useUtils();

  const retryMutation = trpc.system.retryJob.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: "Job re-enqueued" });
      void utils.system.listJobs.invalidate();
      void utils.system.getQueueStats.invalidate();
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const cancelMutation = trpc.system.cancelJob.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: "Job cancelled" });
      void utils.system.listJobs.invalidate();
      void utils.system.getQueueStats.invalidate();
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const stats = statsQuery.data;
  const jobs = listQuery.data ?? [];

  const visibleQueues = useMemo(() => {
    if (!stats?.queues) return [];
    const q = queueSearch.trim().toLowerCase();
    if (!q) return stats.queues;
    return stats.queues.filter((row) => row.queue.toLowerCase().includes(q));
  }, [stats?.queues, queueSearch]);

  return (
    <div className="w-full" style={{ padding: spacing[8] }}>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="m-0 text-2xl font-bold text-foreground">Jobs</h1>
            <Text className="mt-1 text-sm text-default-500">
              pg-boss queue state — running, queued, failed, and completed jobs
              across the pod.
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              void statsQuery.refetch();
              void listQuery.refetch();
            }}
            isDisabled={listQuery.isFetching || statsQuery.isFetching}
          >
            <span className="inline-flex items-center gap-2">
              <IconRefresh
                size={14}
                className={cn(listQuery.isFetching && "animate-spin")}
              />
              Refresh
            </span>
          </Button>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {STATE_ORDER.map((state) => {
            const conf = STATE_CONFIG[state];
            const Icon = conf.icon;
            const count = stats?.totals[state] ?? 0;
            const active = stateFilter === state;
            return (
              <button
                key={state}
                type="button"
                onClick={() => setStateFilter(active ? "all" : state)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  active
                    ? "border-primary/40 bg-primary/5"
                    : "border-divider bg-content1 hover:bg-default-100"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-lg",
                      conf.color === "danger" && "bg-danger/10 text-danger",
                      conf.color === "warning" && "bg-warning/10 text-warning",
                      conf.color === "success" && "bg-success/10 text-success",
                      conf.color === "primary" && "bg-primary/10 text-primary",
                      conf.color === "secondary" &&
                        "bg-secondary/10 text-secondary",
                      conf.color === "default" &&
                        "bg-default-100 text-default-500"
                    )}
                  >
                    <Icon size={14} />
                  </span>
                  <Text className="text-xs uppercase tracking-wide text-default-500">
                    {conf.label}
                  </Text>
                </div>
                <Text className="mt-2 text-2xl font-bold text-foreground">
                  {statsQuery.isLoading ? "—" : count.toLocaleString()}
                </Text>
              </button>
            );
          })}
        </div>

        {/* Filter bar */}
        <Card className="border border-divider">
          <div className="flex flex-wrap items-center gap-3 p-3">
            <Tabs.Root
              selectedKey={stateFilter}
              onSelectionChange={(k) => setStateFilter(k as JobState | "all")}
            >
              <Tabs.List className="gap-1">
                <Tabs.Tab id="all" className="px-3 py-1.5 text-xs">
                  All
                </Tabs.Tab>
                {STATE_ORDER.map((state) => (
                  <Tabs.Tab
                    key={state}
                    id={state}
                    className="px-3 py-1.5 text-xs"
                  >
                    {STATE_CONFIG[state].label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.Root>
            <div className="ml-auto w-full sm:w-64">
              <Input
                size="sm"
                placeholder="Filter by queue name…"
                value={queueSearch}
                onChange={(e) => setQueueSearch(e.target.value)}
                className="border-default-200 bg-background text-foreground"
              />
            </div>
          </div>
        </Card>

        {/* Per-queue summary */}
        {visibleQueues.length > 0 && stateFilter === "all" && !queueSearch && (
          <Card className="border border-divider">
            <div className="border-b border-divider px-4 py-2">
              <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
                Per-queue counts
              </Text>
            </div>
            <div className="divide-y divide-divider/60">
              {visibleQueues
                .sort((a, b) => b.total - a.total)
                .slice(0, 12)
                .map((row) => (
                  <button
                    key={row.queue}
                    type="button"
                    onClick={() => setQueueSearch(row.queue)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs hover:bg-default-100"
                  >
                    <code className="font-mono text-foreground">
                      {row.queue}
                    </code>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      {STATE_ORDER.map((s) => {
                        const c = row.counts[s] ?? 0;
                        if (c === 0) return null;
                        const conf = STATE_CONFIG[s];
                        return (
                          <Chip
                            key={s}
                            size="sm"
                            variant="soft"
                            color={conf.color}
                          >
                            {conf.label}: {c}
                          </Chip>
                        );
                      })}
                    </div>
                  </button>
                ))}
            </div>
          </Card>
        )}

        {/* Job list */}
        <Card className="border border-divider">
          <div className="border-b border-divider px-4 py-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
              Recent jobs ({jobs.length})
            </Text>
          </div>

          {listQuery.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size="lg" color="accent" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-12 text-center">
              <Text className="text-sm text-default-500">
                No jobs match the current filter.
              </Text>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/50 text-left text-xs uppercase tracking-wide text-default-500">
                    <th className="px-4 py-2">Queue</th>
                    <th className="px-4 py-2">State</th>
                    <th className="px-4 py-2">Retry</th>
                    <th className="px-4 py-2">Created</th>
                    <th className="px-4 py-2">Duration</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const conf =
                      STATE_CONFIG[job.state as JobState] ??
                      STATE_CONFIG.created;
                    const isRetryable =
                      job.state === "failed" || job.state === "cancelled";
                    const isCancellable =
                      job.state === "created" ||
                      job.state === "active" ||
                      job.state === "retry";
                    return (
                      <tr
                        key={job.id}
                        className="cursor-pointer border-b border-divider/60 transition-colors hover:bg-default-100"
                        onClick={() => setSelectedId(job.id)}
                      >
                        <td className="px-4 py-2">
                          <code className="font-mono text-xs text-foreground">
                            {job.queue}
                          </code>
                        </td>
                        <td className="px-4 py-2">
                          <Chip size="sm" variant="soft" color={conf.color}>
                            {conf.label}
                          </Chip>
                        </td>
                        <td className="px-4 py-2 text-xs text-default-500">
                          {job.retryCount}/{job.retryLimit}
                        </td>
                        <td className="px-4 py-2 text-xs text-default-500">
                          {timeSince(job.createdOn)}
                        </td>
                        <td className="px-4 py-2 text-xs text-default-500">
                          {duration(job.startedOn, job.completedOn) ?? "—"}
                        </td>
                        <td
                          className="px-4 py-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex justify-end gap-1">
                            {isRetryable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={retryMutation.isPending}
                                onPress={() =>
                                  retryMutation.mutate({ id: job.id })
                                }
                              >
                                <span className="inline-flex items-center gap-1">
                                  <IconArrowBack size={12} />
                                  Retry
                                </span>
                              </Button>
                            )}
                            {isCancellable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={cancelMutation.isPending}
                                onPress={() =>
                                  cancelMutation.mutate({ id: job.id })
                                }
                              >
                                <span className="inline-flex items-center gap-1">
                                  <IconX size={12} />
                                  Cancel
                                </span>
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Details modal */}
      <Modal state={detailsModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header className="border-b border-divider px-5 py-4">
                <div className="flex flex-col gap-1">
                  <Modal.Heading className="text-base font-semibold">
                    Job details
                  </Modal.Heading>
                  {detailsQuery.data && (
                    <code className="text-xs text-default-500">
                      {String(detailsQuery.data.id)}
                    </code>
                  )}
                </div>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="max-h-[70vh] overflow-y-auto px-5 py-4">
                {detailsQuery.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Spinner size="md" />
                  </div>
                ) : detailsQuery.data ? (
                  <JobDetailView
                    data={detailsQuery.data as Record<string, unknown>}
                  />
                ) : (
                  <Text className="text-sm text-default-500">No data.</Text>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function JobDetailView({ data }: { data: Record<string, unknown> }) {
  const meta: Array<[string, unknown]> = [
    ["Queue", data.queue],
    ["State", data.state],
    ["Priority", data.priority],
    ["Retries", `${data.retryCount}/${data.retryLimit}`],
    [
      "Created",
      data.createdOn ? new Date(String(data.createdOn)).toISOString() : "—",
    ],
    [
      "Started",
      data.startedOn ? new Date(String(data.startedOn)).toISOString() : "—",
    ],
    [
      "Completed",
      data.completedOn ? new Date(String(data.completedOn)).toISOString() : "—",
    ],
    ["Singleton key", data.singletonKey],
    ["Dead letter", data.deadLetter],
    ["Policy", data.policy],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {meta.map(([k, v]) => (
          <div key={k}>
            <Text className="text-default-400">{k}</Text>
            <Text className="text-foreground">
              {v == null ? "—" : String(v)}
            </Text>
          </div>
        ))}
      </div>

      <div>
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-default-500">
          Data
        </Text>
        <pre className="overflow-auto rounded-lg border border-divider bg-default-50 p-3 font-mono text-xs text-foreground">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      </div>

      {data.output != null && (
        <div>
          <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-default-500">
            Output
          </Text>
          <pre className="overflow-auto rounded-lg border border-divider bg-default-50 p-3 font-mono text-xs text-foreground">
            {JSON.stringify(data.output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
