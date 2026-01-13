import { useState } from "react";
import {
  Card,
  Text,
  Stack,
  Group,
  Badge,
  Button,
  ThemeIcon,
  Code,
  Collapse,
  TextInput,
  Alert,
} from "@mantine/core";
import {
  IconBolt,
  IconArrowRight,
  IconPlayerPlay,
  IconWebhook,
  IconCpu,
  IconChevronDown,
  IconChevronUp,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { colors, spacing, borderRadius, typography } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";
import SchemaFormGenerator from "../forms/SchemaFormGenerator";

interface EventTypeExplorerProps {
  eventType: string;
  onClose: () => void;
}

export default function EventTypeExplorer({
  eventType,
  onClose,
}: EventTypeExplorerProps) {
  const [showPublish, setShowPublish] = useState(false);
  const [eventData, setEventData] = useState<Record<string, unknown>>({});
  const [userId, setUserId] = useState("test-user");
  const [publishResult, setPublishResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Fetch capabilities for flow context
  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  // Fetch schema for this event type
  const { data: schemaData } = trpc.system.getEventTypeSchema.useQuery(
    { eventType },
    { enabled: !!eventType },
  );

  // Fetch recent events of this type
  const { data: recentEvents } = trpc.system.getRecentEvents.useQuery(
    { limit: 5, eventType },
    { enabled: !!eventType },
  );

  // Publish mutation
  const publishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: (data) => {
      setPublishResult({
        success: true,
        message: `Event published! ID: ${(data as any).eventId}`,
      });
    },
    onError: (error) => {
      setPublishResult({ success: false, message: error.message });
    },
  });

  // Find workers that listen to this event
  const subscribers =
    (capabilities as any)?.workers?.filter((w: any) =>
      w.triggers?.includes(eventType),
    ) || [];

  // Find webhooks subscribed to this event
  const { data: webhooks } = trpc.integrations.list.useQuery(undefined, {
    retry: false,
  });
  const subscribedWebhooks =
    (webhooks as any[])?.filter((wh) => wh.eventTypes?.includes(eventType)) ||
    [];

  const handlePublish = () => {
    publishMutation.mutate({
      type: eventType,
      data: eventData,
      userId: userId || "test-user",
    });
  };

  return (
    <Stack gap="md">
      {/* Header */}
      <Card
        padding="md"
        radius={borderRadius.lg}
        style={{ background: colors.background.secondary }}
      >
        <Group justify="space-between">
          <Group>
            <ThemeIcon size={40} radius="md" color="blue">
              <IconBolt size={24} />
            </ThemeIcon>
            <div>
              <Text size="lg" fw={700}>
                {eventType}
              </Text>
              <Text size="sm" c="dimmed">
                Event Type Deep Dive
              </Text>
            </div>
          </Group>
          <Button variant="subtle" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Card>

      {/* Flow Context */}
      <Card
        padding="md"
        radius={borderRadius.lg}
        style={{ border: `1px solid ${colors.border.default}` }}
      >
        <Text size="sm" fw={600} mb="md">
          Flow Context
        </Text>
        <Group gap="xs" align="center" style={{ flexWrap: "wrap" }}>
          <Badge
            size="lg"
            variant="light"
            color="gray"
            leftSection={<IconArrowRight size={12} />}
          >
            Trigger (API/SDK)
          </Badge>
          <IconArrowRight size={16} color={colors.text.tertiary} />
          <Badge size="lg" variant="filled" color="blue">
            {eventType.split(".").slice(-2).join(".")}
          </Badge>
          <IconArrowRight size={16} color={colors.text.tertiary} />
          <Stack gap={4}>
            {subscribers.length > 0 ? (
              subscribers.map((s: any) => (
                <Badge
                  key={s.name}
                  size="lg"
                  variant="light"
                  color="violet"
                  leftSection={<IconCpu size={12} />}
                >
                  {s.name}
                </Badge>
              ))
            ) : (
              <Badge size="lg" variant="light" color="gray">
                No workers
              </Badge>
            )}
            {subscribedWebhooks.map((wh: any) => (
              <Badge
                key={wh.id}
                size="lg"
                variant="light"
                color="green"
                leftSection={<IconWebhook size={12} />}
              >
                {wh.name}
              </Badge>
            ))}
          </Stack>
        </Group>
      </Card>

      {/* Schema */}
      {schemaData?.hasSchema && schemaData.fields && (
        <Card
          padding="md"
          radius={borderRadius.lg}
          style={{ border: `1px solid ${colors.border.default}` }}
        >
          <Text size="sm" fw={600} mb="md">
            Event Schema
          </Text>
          <Stack gap={4}>
            {schemaData.fields.map((field: any) => (
              <Group key={field.name} gap="xs">
                <Code style={{ fontFamily: typography.fontFamily.mono }}>
                  {field.name}
                </Code>
                <Text size="xs" c="dimmed">
                  {field.type}
                </Text>
                {field.required && (
                  <Badge size="xs" color="red">
                    required
                  </Badge>
                )}
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {/* Publish Test Event */}
      <Card
        padding="md"
        radius={borderRadius.lg}
        style={{ border: `1px solid ${colors.border.default}` }}
      >
        <Group justify="space-between" mb={showPublish ? "md" : 0}>
          <Text size="sm" fw={600}>
            Test: Publish Event
          </Text>
          <Button
            variant="subtle"
            size="xs"
            rightSection={
              showPublish ? (
                <IconChevronUp size={14} />
              ) : (
                <IconChevronDown size={14} />
              )
            }
            onClick={() => setShowPublish(!showPublish)}
          >
            {showPublish ? "Collapse" : "Expand"}
          </Button>
        </Group>
        <Collapse in={showPublish}>
          <Stack gap="sm">
            <TextInput
              label="User ID"
              placeholder="test-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              size="sm"
            />

            {schemaData?.hasSchema ? (
              <SchemaFormGenerator
                eventType={eventType}
                value={eventData}
                onChange={setEventData}
                errors={{}}
              />
            ) : (
              <Text size="xs" c="dimmed">
                No schema available. Using empty payload.
              </Text>
            )}

            <Button
              leftSection={<IconPlayerPlay size={16} />}
              onClick={handlePublish}
              loading={publishMutation.isPending}
              fullWidth
            >
              Publish Test Event
            </Button>

            {publishResult && (
              <Alert
                icon={
                  publishResult.success ? (
                    <IconCheck size={16} />
                  ) : (
                    <IconX size={16} />
                  )
                }
                color={publishResult.success ? "green" : "red"}
              >
                {publishResult.message}
              </Alert>
            )}
          </Stack>
        </Collapse>
      </Card>

      {/* Recent Instances */}
      <Card
        padding="md"
        radius={borderRadius.lg}
        style={{ border: `1px solid ${colors.border.default}` }}
      >
        <Group justify="space-between" mb="sm">
          <Text size="sm" fw={600}>
            Recent Instances
          </Text>
          <Badge variant="light">{recentEvents?.events?.length || 0}</Badge>
        </Group>
        <Stack gap={4}>
          {recentEvents?.events && recentEvents.events.length > 0 ? (
            recentEvents.events.slice(0, 5).map((event: any) => (
              <Group
                key={event.id}
                justify="space-between"
                style={{
                  padding: `${spacing[2]} ${spacing[3]}`,
                  background: colors.background.secondary,
                  borderRadius: borderRadius.base,
                }}
              >
                <Group gap="xs">
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ fontFamily: typography.fontFamily.mono }}
                  >
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </Text>
                  <Text size="xs">{event.userId || "anonymous"}</Text>
                </Group>
                <Badge size="xs" color="green">
                  SUCCESS
                </Badge>
              </Group>
            ))
          ) : (
            <Text size="xs" c="dimmed" ta="center" py="sm">
              No recent events
            </Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
