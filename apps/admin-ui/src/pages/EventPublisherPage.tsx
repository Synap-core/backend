import { useState, Suspense, lazy, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Container,
  Title,
  Text,
  Card,
  Stack,
  Select,
  TextInput,
  Button,
  Group,
  Alert,
  Badge,
  Skeleton,
  SegmentedControl,
  Tabs,
} from '@mantine/core';
import { IconSend, IconInfoCircle, IconCheck, IconX, IconCode, IconForms } from '@tabler/icons-react';
import { trpc } from '../lib/trpc';
import SchemaFormGenerator from '../components/forms/SchemaFormGenerator';
import EventTemplates from '../components/forms/EventTemplates';
import { showSuccessNotification, showErrorNotification } from '../lib/notifications';

// Lazy load Monaco Editor - it's a heavy dependency
const Editor = lazy(() => import('@monaco-editor/react'));

const DEFAULT_EVENT_DATA = {
  content: "Example note content",
  title: "Test Note",
  tags: ["test"],
};

export default function EventPublisherPage() {
  const [searchParams] = useSearchParams();
  const utils = trpc.useUtils();
  const { data: capabilities } = trpc.system.getCapabilities.useQuery();
  const publishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: () => {
      // Invalidate queries if needed
      void utils.system.getCapabilities.invalidate();
    },
  });

  // Load from localStorage for smart defaults
  const getStoredUserId = () => {
    const stored = localStorage.getItem('last-user-id');
    return stored || 'test-user-id';
  };

  const [selectedEventType, setSelectedEventType] = useState<string>('');
  const [userId, setUserId] = useState(getStoredUserId());
  const [eventData, setEventData] = useState(JSON.stringify(DEFAULT_EVENT_DATA, null, 2));
  const [eventDataObject, setEventDataObject] = useState<Record<string, unknown>>(DEFAULT_EVENT_DATA);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Load from URL params (when coming from "Publish Similar")
  useEffect(() => {
    const typeParam = searchParams.get('type');
    const dataParam = searchParams.get('data');
    const userIdParam = searchParams.get('userId');

    if (typeParam) {
      setSelectedEventType(typeParam);
    }
    if (dataParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(dataParam));
        setEventData(JSON.stringify(parsed, null, 2));
        setEventDataObject(parsed);
      } catch {
        // Ignore parse errors
      }
    }
    if (userIdParam) {
      setUserId(decodeURIComponent(userIdParam));
    }
  }, [searchParams]);

  // Save userId to localStorage when it changes
  useEffect(() => {
    if (userId && userId !== 'test-user-id') {
      localStorage.setItem('last-user-id', userId);
    }
  }, [userId]);

  // Check if event type has schema
  const { data: schemaData } = trpc.system.getEventTypeSchema.useQuery(
    { eventType: selectedEventType },
    { enabled: !!selectedEventType }
  );

  const hasSchema = schemaData?.hasSchema ?? false;

  // Reset form data when event type changes
  useEffect(() => {
    if (selectedEventType && hasSchema) {
      setEventDataObject({});
      setEventData('{}');
      setFormErrors({});
    }
  }, [selectedEventType, hasSchema]);

  const handlePublish = async () => {
    try {
      let parsedData: Record<string, unknown>;

      if (inputMode === 'form') {
        // Use form data
        parsedData = eventDataObject;
      } else {
        // Parse JSON
        parsedData = JSON.parse(eventData);
      }

      // Validate required fields if using form
      if (inputMode === 'form' && schemaData?.fields) {
        const errors: Record<string, string> = {};
        for (const field of schemaData.fields) {
          if (field.required && !parsedData[field.name]) {
            errors[field.name] = `${field.name} is required`;
          }
        }
        if (Object.keys(errors).length > 0) {
          setFormErrors(errors);
          showErrorNotification('Please fill in all required fields');
          return;
        }
      }

      // Publish event
      const result = await publishMutation.mutateAsync({
        type: selectedEventType,
        data: parsedData,
        userId,
        source: 'system',
      });

      showSuccessNotification(`Event published successfully! ID: ${result.eventId}`);
      setFormErrors({});
    } catch (error) {
      if (error instanceof SyntaxError) {
        setEditorError(`Invalid JSON: ${error.message}`);
        showErrorNotification(`Invalid JSON: ${error.message}`);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setEditorError(errorMessage);
        showErrorNotification(errorMessage);
      }
    }
  };

  const handleFormDataChange = (newData: Record<string, unknown>) => {
    setEventDataObject(newData);
    setEventData(JSON.stringify(newData, null, 2));
    setFormErrors({});
  };

  const handleTemplateSelect = (template: { eventType: string; data: Record<string, unknown> }) => {
    setSelectedEventType(template.eventType);
    setEventDataObject(template.data);
    setEventData(JSON.stringify(template.data, null, 2));
    setFormErrors({});
  };

  const handleEditorChange = (value: string | undefined) => {
    setEventData(value || '{}');
    setEditorError(null);

    // Try to validate JSON as user types
    try {
      JSON.parse(value || '{}');
    } catch (error) {
      // Silently catch - we'll show error on publish
    }
  };

  const eventTypes = capabilities?.eventTypes.map((et) => ({
    value: et.type,
    label: et.type,
  })) || [];

  return (
    <Container size="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Event Publisher</Title>
          <Text size="sm" c="dimmed">
            Manually publish events to the system for testing and debugging
          </Text>
        </div>

        <Alert icon={<IconInfoCircle size={16} />} title="Testing Tool" color="blue">
          This tool allows you to manually trigger events in the system. Events are validated,
          stored in the event store, and broadcast to all workers and SSE clients.
        </Alert>

        {publishMutation.isSuccess && (
          <Alert icon={<IconCheck size={16} />} title="Event Published" color="green">
            Event published successfully! Check the Live Event Stream to see it.
            <Text size="sm" mt="xs" component="div">
              Event ID: <Badge variant="light">{publishMutation.data?.eventId}</Badge>
            </Text>
          </Alert>
        )}

        {(publishMutation.isError || editorError) && (
          <Alert icon={<IconX size={16} />} title="Error" color="red">
            {editorError || (publishMutation.error as Error)?.message}
          </Alert>
        )}

        <Card withBorder padding="lg">
          <Stack gap="md">
            <EventTemplates onSelectTemplate={handleTemplateSelect} />
            
            <Select
              label="Event Type"
              placeholder="Select an event type"
              data={eventTypes}
              value={selectedEventType}
              onChange={(value) => setSelectedEventType(value || '')}
              searchable
              required
            />

            <TextInput
              label="User ID"
              placeholder="Enter user ID"
              value={userId}
              onChange={(e) => setUserId(e.currentTarget.value)}
              required
            />

            <div>
              <Group justify="space-between" mb="xs">
                <Text size="sm" fw={500}>
                  Event Data
                </Text>
                {hasSchema && (
                  <SegmentedControl
                    value={inputMode}
                    onChange={(value) => setInputMode(value as 'form' | 'json')}
                    data={[
                      { label: 'Form', value: 'form' },
                      { label: 'JSON', value: 'json' },
                    ]}
                    size="xs"
                  />
                )}
              </Group>

              {inputMode === 'form' && hasSchema ? (
                <SchemaFormGenerator
                  eventType={selectedEventType}
                  value={eventDataObject}
                  onChange={handleFormDataChange}
                  errors={formErrors}
                />
              ) : (
                <Suspense fallback={<Skeleton height={400} />}>
                  <div
                    style={{
                      border: '1px solid #dee2e6',
                      borderRadius: '4px',
                      overflow: 'hidden',
                    }}
                  >
                    <Editor
                      height="300px"
                      defaultLanguage="json"
                      value={eventData}
                      onChange={handleEditorChange}
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
                </Suspense>
              )}
            </div>

            <Group justify="flex-end">
              <Button
                leftSection={<IconSend size={16} />}
                onClick={handlePublish}
                disabled={!selectedEventType || !userId || publishMutation.isPending}
                loading={publishMutation.isPending}
              >
                Publish Event
              </Button>
            </Group>
          </Stack>
        </Card>

        <Card withBorder padding="md" bg="gray.0">
          <Title order={4} mb="sm">
            Example Event Data
          </Title>
          <Text size="sm" c="dimmed" mb="xs" component="div">
            For <Badge variant="light">note.creation.requested</Badge>:
          </Text>
          <pre style={{ fontSize: '12px', overflow: 'auto' }}>
            {JSON.stringify(DEFAULT_EVENT_DATA, null, 2)}
          </pre>
        </Card>
      </Stack>
    </Container>
  );
}
