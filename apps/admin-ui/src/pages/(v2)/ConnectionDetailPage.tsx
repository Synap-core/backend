import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Card, Chip, Spinner, Text } from "@heroui/react";
import {
  IconArrowLeft,
  IconRefresh,
  IconRotate,
  IconTrash,
  IconPlugConnected,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showErrorNotification,
  showSuccessNotification,
} from "../../lib/notifications";
import {
  buildFlowTraceUrl,
  extractFlowId,
} from "@synap-core/external-connect-client";

type IntegrationType = "raycast" | "cli" | "openclaw" | "custom";

export default function ConnectionDetailPage() {
  const navigate = useNavigate();
  const params = useParams<{ integrationId: string }>();
  const integration = (params.integrationId ?? "custom") as IntegrationType;
  const [lastFlowId, setLastFlowId] = useState<string | null>(null);

  const keysQuery = trpc.apiKeys.list.useQuery();
  const rotateMutation = trpc.apiKeys.rotate.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({ message: "Key rotated." });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });
  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({ message: "Key revoked." });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });
  const connectMutation = trpc.apiKeys.connectIntegration.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({
        message: "Integration key minted and verified.",
      });
    },
    onError: (err) => {
      const flowId = extractFlowId(err.message);
      setLastFlowId(flowId);
      showErrorNotification({ message: err.message });
    },
  });

  const scopedKeys = useMemo(() => {
    return (keysQuery.data ?? [])
      .filter((k) => k.hubId === `integration:${integration}`)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [keysQuery.data, integration]);

  const activeKeys = scopedKeys.filter((k) => k.isActive);
  const latestKey = scopedKeys[0];

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IconPlugConnected size={22} className="text-primary" />
          <div>
            <Text className="text-2xl font-semibold capitalize">
              {integration} connection
            </Text>
            <Text className="text-sm text-default-500">
              Lifecycle controls and diagnostics for this integration.
            </Text>
          </div>
        </div>
        <Button variant="ghost" onPress={() => navigate("/connections")}>
          <span className="inline-flex items-center gap-1">
            <IconArrowLeft size={14} />
            Back
          </span>
        </Button>
      </div>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Status</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-wrap items-center gap-3">
          {keysQuery.isLoading ? (
            <Spinner size="sm" color="accent" />
          ) : (
            <>
              <Chip size="sm" variant="soft" color="default">
                Active keys: {activeKeys.length}
              </Chip>
              <Chip
                size="sm"
                variant="soft"
                color={latestKey?.isActive ? "success" : "warning"}
              >
                Latest key: {latestKey?.isActive ? "active" : "revoked/none"}
              </Chip>
            </>
          )}
        </Card.Content>
      </Card.Root>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Lifecycle actions</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            isDisabled={connectMutation.isPending}
            onPress={() =>
              connectMutation.mutate({
                integration,
                strategy: "create_new",
              })
            }
          >
            Add new key
          </Button>
          <Button
            variant="primary"
            isDisabled={connectMutation.isPending}
            onPress={() =>
              connectMutation.mutate({
                integration,
                strategy: "replace_existing",
              })
            }
          >
            <span className="inline-flex items-center gap-1">
              <IconRefresh size={14} />
              Reconnect (override existing)
            </span>
          </Button>
          {latestKey && (
            <>
              <Button
                variant="ghost"
                isDisabled={rotateMutation.isPending}
                onPress={() => rotateMutation.mutate({ keyId: latestKey.id })}
              >
                <span className="inline-flex items-center gap-1">
                  <IconRotate size={14} />
                  Rotate latest
                </span>
              </Button>
              <Button
                variant="ghost"
                isDisabled={revokeMutation.isPending}
                onPress={() => revokeMutation.mutate({ keyId: latestKey.id })}
              >
                <span className="inline-flex items-center gap-1">
                  <IconTrash size={14} />
                  Revoke latest
                </span>
              </Button>
            </>
          )}
        </Card.Content>
      </Card.Root>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Credential history</Card.Title>
        </Card.Header>
        <Card.Content>
          {keysQuery.isLoading ? (
            <Spinner size="sm" color="accent" />
          ) : scopedKeys.length === 0 ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  No key history for this integration yet.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-medium border border-divider">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">Key</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Last used</th>
                    <th className="px-3 py-2 font-medium">Usage</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scopedKeys.map((key) => (
                    <tr
                      key={key.id}
                      className="border-b border-divider/60 odd:bg-default-50/20"
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                          <Text className="text-sm font-medium">
                            {key.keyName}
                          </Text>
                          <Text className="font-mono text-xs text-default-500">
                            {key.keyPrefix}
                          </Text>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-default-500">
                        {new Date(key.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-default-500">
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleString()
                          : "Never"}
                      </td>
                      <td className="px-3 py-2 text-default-500">
                        {key.usageCount}
                      </td>
                      <td className="px-3 py-2">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={key.isActive ? "success" : "default"}
                        >
                          {key.isActive ? "Active" : "Revoked"}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Content>
      </Card.Root>

      {lastFlowId ? (
        <Card.Root className="border border-divider">
          <Card.Content className="py-4">
            <Button
              variant="outline"
              onPress={() => {
                window.location.href = buildFlowTraceUrl(lastFlowId);
              }}
            >
              Open failed flow trace
            </Button>
          </Card.Content>
        </Card.Root>
      ) : null}
    </div>
  );
}
