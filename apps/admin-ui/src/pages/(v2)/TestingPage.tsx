import { useState } from 'react';
import {
  Title,
  Text,
  Stack,
  Card,
  Select,
  Textarea,
  Button,
  Group,
  Badge,
  Code,
  ScrollArea,
  Tabs,
  JsonInput,
  Alert,
  Divider,
  Skeleton,
} from '@mantine/core';
import {
  IconFlask,
  IconPlayerPlay,
  IconSend,
  IconClock,
  IconCheck,
  IconX,
  IconAlertCircle,
} from '@tabler/icons-react';
import { colors, typography, spacing, borderRadius } from '../../theme/tokens';
import { trpc } from '../../lib/trpc';
import type { ToolExecutionInput, ToolExecutionOutput, PublishEventResult } from '../../types';
import ToolFormGenerator from '../../components/forms/ToolFormGenerator';
import { showSuccessNotification, showErrorNotification } from '../../lib/notifications';

interface ExecutionHistoryItemInternal {
  id: string;
  timestamp: Date;
  type: 'tool' | 'event';
  name: string;
  input: ToolExecutionInput | Record<string, unknown>;
  output?: ToolExecutionInput | ToolExecutionOutput;
  error?: string;
  success: boolean;
}

export default function TestingPage() {
  const [activeTab, setActiveTab] = useState<string | null>('playground');

  // AI Tools Playground State
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [toolInput, setToolInput] = useState('');
  const [toolInputObject, setToolInputObject] = useState<Record<string, unknown>>({});
  const [toolOutput, setToolOutput] = useState<ToolExecutionOutput | null>(null);
  const [isExecutingTool, setIsExecutingTool] = useState(false);

  // Event Publisher State
  const [eventType, setEventType] = useState<string | null>(null);
  const [eventData, setEventData] = useState('{}');
  const [userId, setUserId] = useState('');
  const [publishResult, setPublishResult] = useState<PublishEventResult | null>(null);

  // Execution History
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItemInternal[]>([]);

  // Fetch available capabilities
  const { data: capabilities, isLoading: isLoadingCapabilities } = trpc.system.getCapabilities.useQuery();

  // Tool execution mutation
  const executeTool = trpc.system.executeTool.useMutation({
    onSuccess: (data) => {
      setToolOutput(data);
      setIsExecutingTool(false);
      showSuccessNotification({
        message: `Tool "${selectedTool}" executed successfully`,
      });
      addToHistory({
        type: 'tool',
        name: selectedTool!,
        input: JSON.parse(toolInput || '{}'),
        output: data,
        success: true,
      });
    },
    onError: (error) => {
      setToolOutput({ error: error.message, success: false } as unknown as ToolExecutionOutput);
      setIsExecutingTool(false);
      showErrorNotification({
        message: `Tool execution failed: ${error.message}`,
      });
      addToHistory({
        type: 'tool',
        name: selectedTool!,
        input: JSON.parse(toolInput || '{}'),
        error: error.message,
        success: false,
      });
    },
  });

  // Event publish mutation
  const publishEvent = trpc.system.publishEvent.useMutation({
    onSuccess: (data) => {
      setPublishResult({ success: true, data });
      showSuccessNotification({
        message: `Event "${eventType}" published successfully`,
        title: 'Event Published',
      });
      addToHistory({
        type: 'event',
        name: eventType!,
        input: { eventType, data: JSON.parse(eventData), userId },
        output: data,
        success: true,
      });
    },
    onError: (error) => {
      setPublishResult({ success: false, error: error.message });
      showErrorNotification({
        message: `Failed to publish event: ${error.message}`,
        title: 'Publish Failed',
      });
      addToHistory({
        type: 'event',
        name: eventType!,
        input: { eventType, data: eventData, userId },
        error: error.message,
        success: false,
      });
    },
  });

  const addToHistory = (item: Omit<ExecutionHistoryItemInternal, 'id' | 'timestamp'>) => {
    setExecutionHistory((prev) => [
      {
        ...item,
        id: Math.random().toString(36).substring(7),
        timestamp: new Date(),
      },
      ...prev.slice(0, 19), // Keep last 20 items
    ]);
  };

  const handleExecuteTool = () => {
    if (!selectedTool) return;
    setIsExecutingTool(true);
    setToolOutput(null);

    let parsedInput;
    try {
      // Use toolInputObject if available, otherwise parse JSON
      if (Object.keys(toolInputObject).length > 0) {
        parsedInput = toolInputObject;
      } else {
        parsedInput = JSON.parse(toolInput || '{}');
      }
    } catch {
      parsedInput = { query: toolInput };
    }

    executeTool.mutate({
      toolName: selectedTool,
      parameters: parsedInput as Record<string, unknown>,
      userId: 'test-user',
    });
  };

  const handlePublishEvent = () => {
    if (!eventType) return;

    try {
      const parsedData = JSON.parse(eventData);
      publishEvent.mutate({
        type: eventType,
        data: parsedData,
        userId: userId || 'test-user',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid JSON in event data';
      setPublishResult({ success: false, error: errorMessage });
    }
  };

  return (
    <div style={{ width: '100%', padding: spacing[8] }}>
      <Stack gap={spacing[8]}>
        {/* Header */}
        <div>
          <Title
            order={1}
            style={{
              fontFamily: typography.fontFamily.sans,
              color: colors.text.primary,
            }}
          >
            Testing
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            Development & Testing Tools
          </Text>
        </div>

        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="playground" leftSection={<IconFlask size={16} />}>
              AI Tools Playground
            </Tabs.Tab>
            <Tabs.Tab value="publisher" leftSection={<IconSend size={16} />}>
              Event Publisher
            </Tabs.Tab>
            <Tabs.Tab value="history" leftSection={<IconClock size={16} />}>
              Execution History
            </Tabs.Tab>
          </Tabs.List>

          {/* AI Tools Playground Tab */}
          <Tabs.Panel value="playground" pt={spacing[4]}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacing[4] }}>
              {/* Left: Input */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  Tool Input
                </Text>
                <Stack gap={spacing[3]}>
                  {isLoadingCapabilities ? (
                    <Stack gap={spacing[2]}>
                      <Skeleton height={20} width={100} />
                      <Skeleton height={36} width="100%" />
                    </Stack>
                  ) : (
                    <Select
                      label="Select Tool"
                      placeholder="Choose an AI tool to test"
                      data={
                        capabilities?.tools.map((tool) => ({
                          value: tool.name,
                          label: tool.name,
                        })) || []
                      }
                      value={selectedTool}
                      onChange={setSelectedTool}
                    />
                  )}

                  {selectedTool && (
                    <>
                      <Alert icon={<IconAlertCircle size={16} />} color="blue">
                        <Text size="xs">
                          {capabilities?.tools.find((t) => t.name === selectedTool)?.description ||
                            'No description available'}
                        </Text>
                      </Alert>
                      <ToolFormGenerator
                        toolName={selectedTool}
                        value={toolInputObject}
                        onChange={(newValue) => {
                          setToolInputObject(newValue);
                          setToolInput(JSON.stringify(newValue, null, 2));
                        }}
                      />
                      <Button
                        leftSection={<IconPlayerPlay size={16} />}
                        onClick={handleExecuteTool}
                        loading={isExecutingTool}
                        disabled={!selectedTool}
                        fullWidth
                      >
                        Execute Tool
                      </Button>
                    </>
                  )}
                </Stack>
              </Card>

              {/* Right: Output */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  Tool Output
                </Text>
                {toolOutput ? (
                  <ScrollArea style={{ height: '400px' }}>
                    <Code block style={{ fontSize: typography.fontSize.xs }}>
                      {JSON.stringify(toolOutput, null, 2)}
                    </Code>
                  </ScrollArea>
                ) : (
                  <Text size="sm" c={colors.text.tertiary} ta="center" p={spacing[6]}>
                    Execute a tool to see output here
                  </Text>
                )}
              </Card>
            </div>
          </Tabs.Panel>

          {/* Event Publisher Tab */}
          <Tabs.Panel value="publisher" pt={spacing[4]}>
            <Card
              padding={spacing[4]}
              radius={borderRadius.lg}
              style={{
                border: `1px solid ${colors.border.default}`,
                backgroundColor: colors.background.primary,
              }}
            >
              <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                Publish Event
              </Text>
              <Stack gap={spacing[3]}>
                <Select
                  label="Event Type"
                  placeholder="Select event type"
                  data={[
                    { value: 'USER_CREATED', label: 'User Created' },
                    { value: 'USER_UPDATED', label: 'User Updated' },
                    { value: 'NOTE_CREATED', label: 'Note Created' },
                    { value: 'NOTE_UPDATED', label: 'Note Updated' },
                    { value: 'NOTE_DELETED', label: 'Note Deleted' },
                    { value: 'AI_CONVERSATION_MESSAGE', label: 'AI Conversation Message' },
                    { value: 'TOOL_EXECUTED', label: 'Tool Executed' },
                    { value: 'CUSTOM_EVENT', label: 'Custom Event' },
                  ]}
                  value={eventType}
                  onChange={setEventType}
                />

                <JsonInput
                  label="Event Data (JSON)"
                  placeholder='{"key": "value"}'
                  value={eventData}
                  onChange={setEventData}
                  minRows={10}
                  validationError="Invalid JSON"
                  formatOnBlur
                  style={{ fontFamily: typography.fontFamily.mono }}
                />

                <Textarea
                  label="User ID (Optional)"
                  placeholder="user@example.com"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                />

                <Button
                  leftSection={<IconSend size={16} />}
                  onClick={handlePublishEvent}
                  loading={publishEvent.isPending}
                  disabled={!eventType}
                  fullWidth
                >
                  Publish Event
                </Button>

                {publishResult && (
                  <Alert
                    icon={publishResult.success ? <IconCheck size={16} /> : <IconX size={16} />}
                    color={publishResult.success ? 'green' : 'red'}
                    mt={spacing[3]}
                  >
                    {publishResult.success ? (
                      <Text size="sm">Event published successfully!</Text>
                    ) : (
                      <Text size="sm">Error: {publishResult.error}</Text>
                    )}
                  </Alert>
                )}
              </Stack>
            </Card>
          </Tabs.Panel>

          {/* Execution History Tab */}
          <Tabs.Panel value="history" pt={spacing[4]}>
            <Card
              padding={spacing[4]}
              radius={borderRadius.lg}
              style={{
                border: `1px solid ${colors.border.default}`,
                backgroundColor: colors.background.primary,
              }}
            >
              <Group justify="space-between" mb={spacing[4]}>
                <Text size="lg" fw={typography.fontWeight.semibold}>
                  Execution History
                </Text>
                <Badge variant="light" color="gray">
                  {executionHistory.length} executions
                </Badge>
              </Group>

              <ScrollArea style={{ height: '600px' }}>
                <Stack gap={spacing[3]}>
                  {executionHistory.length === 0 ? (
                    <Text size="sm" c={colors.text.tertiary} ta="center" p={spacing[6]}>
                      No executions yet. Try running a tool or publishing an event.
                    </Text>
                  ) : (
                    executionHistory.map((item) => (
                      <Card
                        key={item.id}
                        padding={spacing[3]}
                        style={{
                          backgroundColor: colors.background.secondary,
                          border: `1px solid ${colors.border.light}`,
                        }}
                      >
                        <Group justify="space-between" mb={spacing[2]}>
                          <Badge
                            variant="light"
                            color={item.type === 'tool' ? 'blue' : 'purple'}
                            size="sm"
                          >
                            {item.type.toUpperCase()}
                          </Badge>
                          <Badge
                            variant="light"
                            color={item.success ? 'green' : 'red'}
                            size="sm"
                          >
                            {item.success ? 'Success' : 'Failed'}
                          </Badge>
                        </Group>
                        <Text size="sm" fw={typography.fontWeight.medium} mb={spacing[1]}>
                          {item.name}
                        </Text>
                        <Text size="xs" c={colors.text.tertiary} mb={spacing[2]}>
                          {item.timestamp.toLocaleString()}
                        </Text>
                        <Divider my={spacing[2]} />
                        <Text size="xs" c={colors.text.secondary} mb={spacing[1]}>
                          Input:
                        </Text>
                        <Code block style={{ fontSize: '10px', marginBottom: spacing[2] }}>
                          {JSON.stringify(item.input, null, 2)}
                        </Code>
                        {item.output && (
                          <>
                            <Text size="xs" c={colors.text.secondary} mb={spacing[1]}>
                              Output:
                            </Text>
                            <Code block style={{ fontSize: '10px' }}>
                              {JSON.stringify(item.output, null, 2)}
                            </Code>
                          </>
                        )}
                        {item.error && (
                          <>
                            <Text size="xs" c="red" mb={spacing[1]}>
                              Error:
                            </Text>
                            <Code block color="red" style={{ fontSize: '10px' }}>
                              {item.error}
                            </Code>
                          </>
                        )}
                      </Card>
                    ))
                  )}
                </Stack>
              </ScrollArea>
            </Card>
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </div>
  );
}
