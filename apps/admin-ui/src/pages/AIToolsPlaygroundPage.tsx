import { useState } from 'react';
import {
  Container,
  Title,
  Text,
  Stack,
  Select,
  TextInput,
  Button,
  Group,
  Alert,
  Loader,
  Card,
  Code,
  Badge,
  Tabs,
  Timeline,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconPlayerPlay,
  IconTools,
} from '@tabler/icons-react';
import { trpc } from '../lib/trpc';
import Editor from '@monaco-editor/react';

interface ExecutionHistoryItem {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
  result?: unknown;
  error?: string;
  timestamp: Date;
  success: boolean;
}

export default function AIToolsPlaygroundPage() {
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [userId, setUserId] = useState('test-user-id');
  const [parametersJson, setParametersJson] = useState('{}');
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);

  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  const { data: toolSchema, isLoading: schemaLoading } = trpc.system.getToolSchema.useQuery(
    { toolName: selectedTool },
    { enabled: !!selectedTool }
  );

  const executeMutation = trpc.system.executeTool.useMutation({
    onSuccess: (data) => {
      addToHistory({
        toolName: selectedTool,
        parameters: JSON.parse(parametersJson),
        result: data.result,
        success: data.success,
      });
    },
    onError: (error) => {
      addToHistory({
        toolName: selectedTool,
        parameters: JSON.parse(parametersJson),
        error: error.message,
        success: false,
      });
    },
  });

  const addToHistory = (item: Omit<ExecutionHistoryItem, 'id' | 'timestamp'>) => {
    setExecutionHistory((prev) => [
      {
        ...item,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
      ...prev.slice(0, 19), // Keep last 20 executions
    ]);
  };

  const handleExecute = async () => {
    try {
      const parameters = JSON.parse(parametersJson);

      await executeMutation.mutateAsync({
        toolName: selectedTool,
        parameters,
        userId,
      });
    } catch (error) {
      // JSON parse error or mutation error
      if (error instanceof SyntaxError) {
        addToHistory({
          toolName: selectedTool,
          parameters: {},
          error: `Invalid JSON: ${error.message}`,
          success: false,
        });
      }
    }
  };

  const handleToolChange = (value: string | null) => {
    if (value) {
      setSelectedTool(value);
      setParametersJson('{}'); // Reset parameters when tool changes
    }
  };

  const tools = capabilities?.tools || [];

  return (
    <Container size="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>AI Tools Playground</Title>
          <Text size="sm" c="dimmed">
            Test and debug AI tools in isolation with custom parameters
          </Text>
        </div>

        <Alert icon={<IconInfoCircle size={16} />} title="Testing Environment" color="blue">
          This playground allows you to execute AI tools independently of the event system. Perfect
          for testing tool behavior, debugging, and understanding tool schemas.
        </Alert>

        <Card withBorder padding="lg">
          <Stack gap="md">
            <Select
              label="Select AI Tool"
              placeholder="Choose a tool to test..."
              data={tools.map((t) => ({ value: t.name, label: t.name }))}
              value={selectedTool}
              onChange={handleToolChange}
              searchable
              required
            />

            {selectedTool && (
              <>
                {schemaLoading ? (
                  <Loader size="sm" />
                ) : toolSchema ? (
                  <Alert icon={<IconTools size={16} />} title="Tool Information" color="gray">
                    <Stack gap="xs">
                      <Text size="sm">
                        <strong>Description:</strong> {toolSchema.description}
                      </Text>
                      <Group gap="xs">
                        <Badge variant="outline">{toolSchema.metadata.version}</Badge>
                        <Badge color={toolSchema.metadata.source === 'core' ? 'blue' : 'gray'}>
                          {toolSchema.metadata.source}
                        </Badge>
                      </Group>
                    </Stack>
                  </Alert>
                ) : null}

                <TextInput
                  label="User ID"
                  placeholder="Enter user ID for execution context..."
                  value={userId}
                  onChange={(e) => setUserId(e.currentTarget.value)}
                  required
                />

                <div>
                  <Text size="sm" fw={500} mb="xs">
                    Tool Parameters (JSON)
                  </Text>
                  {toolSchema && (
                    <Text size="xs" c="dimmed" mb="xs">
                      Required fields:{' '}
                      {toolSchema.schema.required?.join(', ') || 'None (all optional)'}
                    </Text>
                  )}
                  <div
                    style={{
                      border: '1px solid #dee2e6',
                      borderRadius: '4px',
                      overflow: 'hidden',
                    }}
                  >
                    <Editor
                      height="200px"
                      defaultLanguage="json"
                      value={parametersJson}
                      onChange={(value) => setParametersJson(value || '{}')}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                      }}
                      theme="vs-light"
                    />
                  </div>
                  {toolSchema && (
                    <Code block mt="xs" style={{ fontSize: '11px' }}>
                      {JSON.stringify(toolSchema.schema.properties, null, 2)}
                    </Code>
                  )}
                </div>

                <Group justify="flex-end">
                  <Button
                    leftSection={<IconPlayerPlay size={16} />}
                    onClick={handleExecute}
                    disabled={!selectedTool || !userId}
                    loading={executeMutation.isPending}
                  >
                    Execute Tool
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Card>

        {/* Results and History */}
        {executionHistory.length > 0 && (
          <Tabs defaultValue="latest">
            <Tabs.List>
              <Tabs.Tab value="latest">Latest Result</Tabs.Tab>
              <Tabs.Tab value="history">Execution History ({executionHistory.length})</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="latest" pt="md">
              {executionHistory[0] && (
                <Card withBorder padding="md">
                  <Stack gap="md">
                    <Group justify="space-between">
                      <Text fw={500}>
                        {executionHistory[0].toolName} - {executionHistory[0].timestamp.toLocaleTimeString()}
                      </Text>
                      <Badge
                        color={executionHistory[0].success ? 'green' : 'red'}
                        leftSection={executionHistory[0].success ? <IconCheck size={14} /> : <IconX size={14} />}
                      >
                        {executionHistory[0].success ? 'Success' : 'Failed'}
                      </Badge>
                    </Group>

                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        Parameters
                      </Text>
                      <Code block>{JSON.stringify(executionHistory[0].parameters, null, 2)}</Code>
                    </div>

                    {executionHistory[0].success ? (
                      <div>
                        <Text size="sm" fw={500} mb="xs">
                          Result
                        </Text>
                        <Code block>{JSON.stringify(executionHistory[0].result, null, 2)}</Code>
                      </div>
                    ) : (
                      <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red">
                        {executionHistory[0].error}
                      </Alert>
                    )}
                  </Stack>
                </Card>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="history" pt="md">
              <Card withBorder padding="md">
                <Timeline bulletSize={20}>
                  {executionHistory.map((item) => (
                    <Timeline.Item
                      key={item.id}
                      bullet={item.success ? <IconCheck size={12} /> : <IconX size={12} />}
                      color={item.success ? 'green' : 'red'}
                    >
                      <Group justify="space-between" mb="xs">
                        <Text size="sm" fw={500}>
                          {item.toolName}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {item.timestamp.toLocaleTimeString()}
                        </Text>
                      </Group>
                      {item.error ? (
                        <Text size="xs" c="red">
                          Error: {item.error}
                        </Text>
                      ) : (
                        <Text size="xs" c="dimmed">
                          Executed with {Object.keys(item.parameters).length} parameter(s)
                        </Text>
                      )}
                    </Timeline.Item>
                  ))}
                </Timeline>
              </Card>
            </Tabs.Panel>
          </Tabs>
        )}
      </Stack>
    </Container>
  );
}
