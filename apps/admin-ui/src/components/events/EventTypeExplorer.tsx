import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Label,
  Spinner,
  Text,
} from "@heroui/react";
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
import { colors, borderRadius, typography } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";
import SchemaFormGenerator from "../forms/SchemaFormGenerator";

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent w-full rounded-lg border px-3 py-2 text-sm outline-none";

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

  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  const { data: schemaData } = trpc.system.getEventTypeSchema.useQuery(
    { eventType },
    { enabled: !!eventType }
  );

  const { data: recentEvents } = trpc.system.getRecentEvents.useQuery(
    { limit: 5, eventType },
    { enabled: !!eventType }
  );

  const publishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: (data) => {
      setPublishResult({
        success: true,
        message: `Event published! ID: ${(data as { eventId?: string }).eventId ?? ""}`,
      });
    },
    onError: (error) => {
      setPublishResult({ success: false, message: error.message });
    },
  });

  interface Worker {
    name: string;
    triggers?: string[];
  }
  interface Webhook {
    id: string;
    name: string;
    url?: string;
    eventTypes?: string[];
  }

  const subscribers: Worker[] =
    (capabilities as { workers?: Worker[] } | undefined)?.workers?.filter((w) =>
      w.triggers?.includes(eventType)
    ) || [];

  const { data: webhooks } = trpc.integrations.list.useQuery(undefined, {
    retry: false,
  });
  const subscribedWebhooks: Webhook[] =
    (webhooks as Webhook[] | undefined)?.filter((wh) =>
      wh.eventTypes?.includes(eventType)
    ) || [];

  const handlePublish = () => {
    publishMutation.mutate({
      type: eventType,
      data: eventData,
      userId: userId || "test-user",
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        className="border border-transparent p-4"
        style={{
          borderRadius: borderRadius.lg,
          background: colors.background.secondary,
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <IconBolt size={24} />
            </div>
            <div>
              <Text className="text-lg font-bold">{eventType}</Text>
              <Text className="text-sm text-default-500">
                Event Type Deep Dive
              </Text>
            </div>
          </div>
          <Button variant="ghost" size="sm" onPress={onClose}>
            Close
          </Button>
        </div>
      </Card>

      <Card
        className="border border-divider p-4"
        style={{ borderRadius: borderRadius.lg }}
      >
        <Text className="mb-3 text-sm font-semibold">Flow Context</Text>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color="default">
            <span className="inline-flex items-center gap-1">
              <IconArrowRight size={12} />
              Trigger (API/SDK)
            </span>
          </Chip>
          <IconArrowRight size={16} color={colors.text.tertiary} />
          <Chip size="sm" variant="soft" color="accent">
            {eventType.split(".").slice(-2).join(".")}
          </Chip>
          <IconArrowRight size={16} color={colors.text.tertiary} />
          <div className="flex flex-col gap-1">
            {subscribers.length > 0 ? (
              subscribers.map((s) => (
                <Chip key={s.name} size="sm" variant="soft" color="warning">
                  <span className="inline-flex items-center gap-1">
                    <IconCpu size={12} />
                    {s.name}
                  </span>
                </Chip>
              ))
            ) : (
              <Chip size="sm" variant="soft" color="default">
                No workers
              </Chip>
            )}
            {subscribedWebhooks.map((wh) => (
              <Chip key={wh.id} size="sm" variant="soft" color="success">
                <span className="inline-flex items-center gap-1">
                  <IconWebhook size={12} />
                  {wh.name}
                </span>
              </Chip>
            ))}
          </div>
        </div>
      </Card>

      {schemaData?.hasSchema && schemaData.fields && (
        <Card
          className="border border-divider p-4"
          style={{ borderRadius: borderRadius.lg }}
        >
          <Text className="mb-3 text-sm font-semibold">Event Schema</Text>
          <div className="flex flex-col gap-1">
            {schemaData.fields.map(
              (field: { name: string; type: string; required: boolean }) => (
                <div
                  key={field.name}
                  className="flex flex-wrap items-center gap-2"
                >
                  <code
                    className="rounded bg-default-100 px-1.5 py-0.5 text-xs"
                    style={{ fontFamily: typography.fontFamily.mono }}
                  >
                    {field.name}
                  </code>
                  <Text className="text-xs text-default-500">{field.type}</Text>
                  {field.required ? (
                    <Chip size="sm" variant="soft" color="danger">
                      required
                    </Chip>
                  ) : null}
                </div>
              )
            )}
          </div>
        </Card>
      )}

      <Card
        className="border border-divider p-4"
        style={{ borderRadius: borderRadius.lg }}
      >
        <div className="mb-2 flex items-center justify-between">
          <Text className="text-sm font-semibold">Test: Publish Event</Text>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setShowPublish(!showPublish)}
          >
            <span className="inline-flex items-center gap-1">
              {showPublish ? (
                <IconChevronUp size={14} />
              ) : (
                <IconChevronDown size={14} />
              )}
              {showPublish ? "Collapse" : "Expand"}
            </span>
          </Button>
        </div>
        {showPublish ? (
          <div className="flex flex-col gap-3">
            <div>
              <Label className="text-default-600">User ID</Label>
              <Input
                className={`${inputClass} mt-1`}
                placeholder="test-user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>

            {schemaData?.hasSchema ? (
              <SchemaFormGenerator
                eventType={eventType}
                value={eventData}
                onChange={setEventData}
                errors={{}}
              />
            ) : (
              <Text className="text-xs text-default-500">
                No schema available. Using empty payload.
              </Text>
            )}

            <Button
              variant="primary"
              fullWidth
              onPress={handlePublish}
              isDisabled={publishMutation.isPending}
            >
              {publishMutation.isPending ? (
                <Spinner size="sm" color="current" />
              ) : (
                <span className="inline-flex items-center gap-2">
                  <IconPlayerPlay size={16} />
                  Publish Test Event
                </span>
              )}
            </Button>

            {publishResult ? (
              <Alert status={publishResult.success ? "success" : "danger"}>
                <Alert.Indicator>
                  {publishResult.success ? (
                    <IconCheck size={16} />
                  ) : (
                    <IconX size={16} />
                  )}
                </Alert.Indicator>
                <Alert.Content>
                  <Alert.Description>{publishResult.message}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card
        className="border border-divider p-4"
        style={{ borderRadius: borderRadius.lg }}
      >
        <div className="mb-2 flex items-center justify-between">
          <Text className="text-sm font-semibold">Recent Instances</Text>
          <Chip size="sm" variant="soft" color="default">
            {recentEvents?.events?.length || 0}
          </Chip>
        </div>
        <div className="flex flex-col gap-1">
          {recentEvents?.events && recentEvents.events.length > 0 ? (
            recentEvents.events.slice(0, 5).map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2"
                style={{
                  background: colors.background.secondary,
                  borderRadius: borderRadius.base,
                }}
              >
                <div className="flex items-center gap-2">
                  <Text
                    className="text-xs text-default-500"
                    style={{ fontFamily: typography.fontFamily.mono }}
                  >
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </Text>
                  <Text className="text-xs">{event.userId || "anonymous"}</Text>
                </div>
                <Chip size="sm" variant="soft" color="success">
                  SUCCESS
                </Chip>
              </div>
            ))
          ) : (
            <Text className="py-2 text-center text-xs text-default-500">
              No recent events
            </Text>
          )}
        </div>
      </Card>
    </div>
  );
}
