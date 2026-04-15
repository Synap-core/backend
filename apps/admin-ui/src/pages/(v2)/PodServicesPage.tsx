import { Card, Chip, Spinner, Text } from "@heroui/react";
import {
  IconServer2,
  IconHeartbeat,
  IconTopologyStar3,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";

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
  const healthQuery = trpc.system.getServiceHealth.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const capabilitiesQuery = trpc.capabilities.list.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const healthyCount = (healthQuery.data ?? []).filter(
    (s) => s.status === "healthy"
  ).length;
  const totalCount = (healthQuery.data ?? []).length;

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
            <div className="overflow-x-auto rounded-medium border border-divider">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">Service</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(healthQuery.data ?? []).map((row) => (
                    <tr
                      key={row.name}
                      className="border-b border-divider/60 odd:bg-default-50/20"
                    >
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">
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
                      </td>
                      <td className="px-3 py-2 text-default-500">
                        {row.message ?? "—"}
                        {typeof row.latency === "number"
                          ? ` · ${row.latency}ms`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
    </div>
  );
}
