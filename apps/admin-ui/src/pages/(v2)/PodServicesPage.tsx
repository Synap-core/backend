import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Modal,
  Spinner,
  Table,
  Text,
  useOverlayState,
} from "@heroui/react";
import {
  IconServer2,
  IconHeartbeat,
  IconTopologyStar3,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showErrorNotification,
  showSuccessNotification,
} from "../../lib/notifications";

const EXPECTED_SERVICES = [
  "backend",
  "realtime",
  "postgres",
  "redis",
  "minio",
  "typesense",
  "kratos",
  "hydra",
  "caddy",
  "pod-agent",
];

export default function PodServicesPage() {
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const logsModal = useOverlayState({
    isOpen: logsOpen,
    onOpenChange: setLogsOpen,
  });

  const healthQuery = trpc.system.getServiceHealth.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const capabilitiesQuery = trpc.capabilities.list.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const runtimeConfigQuery = trpc.system.getPodRuntimeConfig.useQuery();
  const corsQuery = trpc.system.getCorsSettings.useQuery();
  const serviceLogsQuery = trpc.system.getServiceLogs.useQuery(
    { service: selectedService ?? "backend", tail: 300 },
    { enabled: !!selectedService && logsOpen }
  );
  const updateCorsMutation = trpc.system.updateCorsSettings.useMutation({
    onSuccess: () => {
      void corsQuery.refetch();
      showSuccessNotification({ message: "CORS origins updated." });
    },
    onError: (err) => {
      showErrorNotification({ message: err.message });
    },
  });
  const [corsInput, setCorsInput] = useState("");

  const healthyCount = (healthQuery.data ?? []).filter(
    (s) => s.status === "healthy"
  ).length;
  const totalCount = (healthQuery.data ?? []).length;
  const isDomainCollision = useMemo(() => {
    const env = runtimeConfigQuery.data?.env ?? [];
    const domain = env.find((item) => item.key === "DOMAIN")?.value;
    const openclawDomain = env.find(
      (item) => item.key === "OPENCLAW_DOMAIN"
    )?.value;
    return (
      !!domain &&
      !!openclawDomain &&
      domain !== "disabled.invalid" &&
      openclawDomain !== "disabled.invalid" &&
      domain === openclawDomain
    );
  }, [runtimeConfigQuery.data]);

  useEffect(() => {
    if (!corsQuery.data) return;
    setCorsInput((corsQuery.data.dbOrigins ?? []).join("\n"));
  }, [corsQuery.data]);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6 md:p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <IconServer2 className="text-primary" size={24} />
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            Pod services
          </Text>
        </div>
        <Text className="max-w-3xl text-small text-default-500">
          Runtime health for the core services that keep this Data Pod online.
        </Text>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-1 p-4">
            <div className="inline-flex items-center gap-2 text-default-500">
              <IconHeartbeat size={16} />
              <Text className="text-xs uppercase tracking-wider">Health</Text>
            </div>
            <Text className="text-2xl font-semibold">
              {healthyCount}/{totalCount || 0}
            </Text>
            <Text className="text-xs text-default-500">Services healthy</Text>
          </Card.Content>
        </Card.Root>
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-1 p-4">
            <div className="inline-flex items-center gap-2 text-default-500">
              <IconTopologyStar3 size={16} />
              <Text className="text-xs uppercase tracking-wider">
                Intelligence
              </Text>
            </div>
            <Text className="text-2xl font-semibold">
              {capabilitiesQuery.data?.intelligenceServices?.length ?? 0}
            </Text>
            <Text className="text-xs text-default-500">
              Registered services
            </Text>
          </Card.Content>
        </Card.Root>
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-1 p-4">
            <Text className="text-xs uppercase tracking-wider text-default-500">
              Compose inventory
            </Text>
            <Text className="text-2xl font-semibold">
              {EXPECTED_SERVICES.length}
            </Text>
            <Text className="text-xs text-default-500">
              Expected core services
            </Text>
          </Card.Content>
        </Card.Root>
      </div>

      {isDomainCollision ? (
        <Card.Root className="border border-danger/30 bg-danger/10">
          <Card.Content className="p-4">
            <Text className="text-sm font-semibold text-danger">
              OpenClaw domain collision detected
            </Text>
            <Text className="mt-1 text-xs text-danger">
              `OPENCLAW_DOMAIN` matches `DOMAIN`, which can cause redirect
              loops. Use a dedicated subdomain (for example
              `openclaw.your-domain`).
            </Text>
          </Card.Content>
        </Card.Root>
      ) : null}

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Runtime checks</Card.Title>
          <Card.Description>
            Live dependency checks from{" "}
            <code className="text-xs">system.getServiceHealth</code>.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {healthQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner color="accent" />
            </div>
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Runtime service checks">
                  <Table.Header>
                    <Table.Column>Service</Table.Column>
                    <Table.Column>Status</Table.Column>
                    <Table.Column>Detail</Table.Column>
                    <Table.Column>Logs</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {(healthQuery.data ?? []).map((row) => (
                      <Table.Row key={row.name} id={row.name}>
                        <Table.Cell>
                          <span className="font-medium">{row.name}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={
                              row.status === "healthy"
                                ? "success"
                                : row.status === "degraded"
                                  ? "warning"
                                  : "danger"
                            }
                          >
                            {row.status}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-default-500">
                            {row.message ?? "—"}
                            {typeof row.latency === "number"
                              ? ` · ${row.latency}ms`
                              : ""}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            size="sm"
                            variant="outline"
                            onPress={() => {
                              setSelectedService(
                                row.name.toLowerCase() === "postgres"
                                  ? "postgres"
                                  : row.name.toLowerCase()
                              );
                              setLogsOpen(true);
                            }}
                          >
                            View logs
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </Card.Content>
      </Card.Root>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Expected pod services</Card.Title>
          <Card.Description>
            Canonical inventory from deployment manifests (core runtime
            baseline).
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="flex flex-wrap gap-2">
            {EXPECTED_SERVICES.map((name) => (
              <Chip key={name} size="sm" variant="soft" color="default">
                {name}
              </Chip>
            ))}
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Runtime configuration</Card.Title>
          <Card.Description>
            Sanitized environment and edge proxy config visibility (pod-admin).
          </Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          {runtimeConfigQuery.isLoading ? (
            <Spinner size="sm" color="accent" />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {(runtimeConfigQuery.data?.env ?? []).map((item) => (
                  <Chip key={item.key} size="sm" variant="soft" color="default">
                    {item.key}: {item.value ?? "unset"}
                  </Chip>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <ConfigPanel
                  title="Caddyfile"
                  path={runtimeConfigQuery.data?.files.caddyfile.path ?? null}
                  content={
                    runtimeConfigQuery.data?.files.caddyfile.content ?? null
                  }
                />
                <ConfigPanel
                  title="OpenClaw auth snippet"
                  path={
                    runtimeConfigQuery.data?.files.openclawAuthSnippet.path ??
                    null
                  }
                  content={
                    runtimeConfigQuery.data?.files.openclawAuthSnippet
                      .content ?? null
                  }
                />
              </div>
            </>
          )}
        </Card.Content>
      </Card.Root>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Network & CORS configuration</Card.Title>
          <Card.Description>
            Environment origins are read-only. DB origins are editable and
            applied dynamically.
          </Card.Description>
        </Card.Header>
        <Card.Content className="space-y-3">
          {corsQuery.isLoading ? (
            <Spinner size="sm" color="accent" />
          ) : (
            <>
              <div>
                <Text className="mb-1 text-xs uppercase tracking-wider text-default-500">
                  Environment origins (read-only)
                </Text>
                <div className="flex flex-wrap gap-2">
                  {(corsQuery.data?.envOrigins ?? []).map((origin) => (
                    <Chip key={origin} size="sm" variant="soft" color="default">
                      {origin}
                    </Chip>
                  ))}
                  {(corsQuery.data?.envOrigins ?? []).length === 0 ? (
                    <Text className="text-xs text-default-500">
                      No env origins.
                    </Text>
                  ) : null}
                </div>
              </div>

              <div>
                <Text className="mb-1 text-xs uppercase tracking-wider text-default-500">
                  Database origins (editable, one URL per line)
                </Text>
                <textarea
                  value={corsInput}
                  onChange={(e) => setCorsInput(e.target.value)}
                  rows={5}
                  className="w-full rounded-medium border border-divider bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  placeholder="https://example.com"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  isDisabled={updateCorsMutation.isPending}
                  onPress={() => {
                    const origins = corsInput
                      .split(/[\n,]/g)
                      .map((o) => o.trim())
                      .filter(Boolean);
                    updateCorsMutation.mutate({ origins });
                  }}
                >
                  Save CORS origins
                </Button>
                <Text className="text-xs text-default-500">
                  Merged origins currently active:{" "}
                  {(corsQuery.data?.merged ?? []).length}
                </Text>
              </div>
            </>
          )}
        </Card.Content>
      </Card.Root>

      <Modal state={logsModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="cover" placement="center" scroll="inside">
            <Modal.Dialog>
              <Modal.Header className="border-b border-divider px-6 py-4">
                <Modal.Heading>
                  Service logs{selectedService ? `: ${selectedService}` : ""}
                </Modal.Heading>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="px-6 py-4">
                {serviceLogsQuery.isLoading ? (
                  <Spinner size="sm" color="accent" />
                ) : serviceLogsQuery.data?.error ? (
                  <Text className="text-sm text-danger-600">
                    {serviceLogsQuery.data.error}
                  </Text>
                ) : (
                  <pre className="max-h-[60vh] overflow-auto rounded-medium border border-divider bg-default-50/50 p-3 text-xs text-default-700">
                    {serviceLogsQuery.data?.logs ?? "No logs returned."}
                  </pre>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function ConfigPanel({
  title,
  path,
  content,
}: {
  title: string;
  path: string | null;
  content: string | null;
}) {
  return (
    <div className="rounded-medium border border-divider p-3">
      <Text className="text-sm font-semibold">{title}</Text>
      <Text className="mb-2 text-xs text-default-500">
        {path ? `Path: ${path}` : "File path unavailable in this runtime"}
      </Text>
      <pre className="max-h-56 overflow-auto rounded border border-divider bg-default-50/40 p-2 text-xs text-default-700">
        {content ?? "Content unavailable"}
      </pre>
    </div>
  );
}
