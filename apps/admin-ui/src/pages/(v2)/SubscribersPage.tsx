import { useState } from 'react';
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Table,
  Button,
  Badge,
  ActionIcon,
  Modal,
  TextInput,
  MultiSelect,
  Code,
  Tabs,
  SimpleGrid,
  ThemeIcon,
  Drawer,
  ScrollArea,
  Divider,
} from '@mantine/core';
import { useQuery, useMutation } from '@tanstack/react-query';
import { 
  IconWebhook, IconRefresh, IconPlus, IconTrash, IconCheck,
  IconCpu, IconBolt, IconArrowRight
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { colors, typography, spacing, borderRadius } from '../../theme/tokens';
import { AdminSDK } from '../../lib/sdk';
import { trpc } from '../../lib/trpc';

export default function SubscribersPage() {
  const [activeTab, setActiveTab] = useState<string | null>('workers');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newWebhook, setNewWebhook] = useState({ name: '', url: '', eventTypes: [] as string[] });
  const [selectedWorker, setSelectedWorker] = useState<any | null>(null);

  // Fetch capabilities for event types and workers
  const { data: capabilities } = trpc.system.getCapabilities.useQuery();
  const workers = (capabilities as any)?.workers || [];

  // List Webhooks
  const { data: webhooks, isLoading, refetch, error } = useQuery({
    queryKey: ['webhooks', 'list'],
    queryFn: () => AdminSDK.webhooks.list(),
    retry: false,
  });

  // Create Webhook
  const createMutation = useMutation({
    mutationFn: (data: any) => AdminSDK.webhooks.create(data),
    onSuccess: () => {
      notifications.show({ title: 'Webhook Created', message: 'Subscription added', color: 'green' });
      setCreateModalOpen(false);
      setNewWebhook({ name: '', url: '', eventTypes: [] });
      refetch();
    },
    onError: (err: any) => {
      notifications.show({ title: 'Failed', message: err.message, color: 'red' });
    }
  });

  // Delete Webhook
  const deleteMutation = useMutation({
    mutationFn: (id: string) => AdminSDK.webhooks.delete(id),
    onSuccess: () => {
      notifications.show({ title: 'Deleted', message: 'Webhook removed', color: 'green' });
      refetch();
    }
  });

  return (
    <div style={{ width: '100%', padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <div>
          <Title order={1} style={{ fontFamily: typography.fontFamily.sans, color: colors.text.primary }}>
            Automation
          </Title>
          <Text size="sm" style={{ color: colors.text.secondary }}>
            Workers, webhooks & event subscriptions
          </Text>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="workers" leftSection={<IconCpu size={16} />}>
              Workers ({workers.length})
            </Tabs.Tab>
            <Tabs.Tab value="webhooks" leftSection={<IconWebhook size={16} />}>
              Webhooks ({(webhooks as any[])?.length || 0})
            </Tabs.Tab>
          </Tabs.List>

          {/* Workers Tab */}
          <Tabs.Panel value="workers" pt="md">
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
              {workers.map((worker: any) => (
                <Card 
                  key={worker.name}
                  padding="md" 
                  radius="md"
                  style={{ 
                    cursor: 'pointer', 
                    border: `1px solid ${colors.border.light}`,
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setSelectedWorker(worker)}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.border.interactive; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border.light; }}
                >
                  <Group gap="sm" mb="sm">
                    <ThemeIcon size={36} radius="md" color="violet" variant="light">
                      <IconCpu size={20} />
                    </ThemeIcon>
                    <div style={{ flex: 1 }}>
                      <Text size="sm" fw={500}>{worker.name}</Text>
                      <Text size="xs" c="dimmed">{worker.description || 'Inngest Worker'}</Text>
                    </div>
                  </Group>
                  
                  <Group gap={4} wrap="wrap">
                    {worker.triggers?.slice(0, 2).map((trigger: string) => (
                      <Badge key={trigger} size="xs" variant="light" color="blue">
                        {trigger.split('.').slice(-2).join('.')}
                      </Badge>
                    ))}
                    {worker.triggers?.length > 2 && (
                      <Badge size="xs" variant="light" color="gray">
                        +{worker.triggers.length - 2} more
                      </Badge>
                    )}
                  </Group>
                </Card>
              ))}
              
              {workers.length === 0 && (
                <Card padding="xl" style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
                  <Text c="dimmed">No workers registered</Text>
                </Card>
              )}
            </SimpleGrid>
          </Tabs.Panel>

          {/* Webhooks Tab */}
          <Tabs.Panel value="webhooks" pt="md">
            <Card padding="md" radius={borderRadius.lg} style={{ border: `1px solid ${colors.border.default}` }}>
              <Group justify="space-between" mb="md">
                <Text size="lg" fw={600}>Webhooks</Text>
                <Group>
                  <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => refetch()} loading={isLoading}>
                    Refresh
                  </Button>
                  <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateModalOpen(true)}>
                    Add Webhook
                  </Button>
                </Group>
              </Group>

              {error ? (
                <Text c="red" size="sm">Failed to load webhooks: {(error as Error).message}</Text>
              ) : (
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>URL</Table.Th>
                      <Table.Th>Event Types</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {(webhooks as any[])?.map((wh: any) => (
                      <Table.Tr key={wh.id}>
                        <Table.Td><Text size="sm" fw={500}>{wh.name}</Text></Table.Td>
                        <Table.Td>
                          <Code style={{ fontSize: typography.fontSize.xs }}>{wh.url}</Code>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            {wh.eventTypes?.slice(0, 2).map((et: string) => (
                              <Badge key={et} size="xs" variant="light">{et.split('.').slice(-2).join('.')}</Badge>
                            ))}
                            {wh.eventTypes?.length > 2 && (
                              <Badge size="xs" variant="light" color="gray">+{wh.eventTypes.length - 2}</Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Badge color="green" size="sm" leftSection={<IconCheck size={10} />}>Active</Badge>
                        </Table.Td>
                        <Table.Td>
                          <ActionIcon 
                            variant="subtle" 
                            color="red" 
                            onClick={() => deleteMutation.mutate(wh.id)}
                            loading={deleteMutation.isPending}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                    {(!webhooks || (webhooks as any[]).length === 0) && (
                      <Table.Tr>
                        <Table.Td colSpan={5}>
                          <Text ta="center" c="dimmed" py="lg">No webhooks configured</Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              )}
            </Card>
          </Tabs.Panel>
        </Tabs>
      </Stack>

      {/* Worker Details Drawer */}
      <Drawer
        opened={!!selectedWorker}
        onClose={() => setSelectedWorker(null)}
        position="right"
        size="lg"
        title={
          <Group>
            <ThemeIcon size={28} radius="md" color="violet">
              <IconCpu size={16} />
            </ThemeIcon>
            <Text size="lg" fw={600}>{selectedWorker?.name}</Text>
          </Group>
        }
      >
        {selectedWorker && (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={600} mb="xs">Description</Text>
              <Text size="sm" c="dimmed">{selectedWorker.description || 'No description'}</Text>
            </div>

            <Divider />

            <div>
              <Text size="sm" fw={600} mb="xs">Triggers ({selectedWorker.triggers?.length || 0})</Text>
              <Stack gap={4}>
                {selectedWorker.triggers?.map((trigger: string) => (
                  <Group key={trigger} gap="xs">
                    <IconBolt size={14} color={colors.eventTypes.created} />
                    <Code style={{ fontSize: typography.fontSize.xs }}>{trigger}</Code>
                  </Group>
                ))}
              </Stack>
            </div>

            <Divider />

            <div>
              <Text size="sm" fw={600} mb="xs">Flow</Text>
              <Group gap="xs" align="center">
                <Badge variant="light" color="blue" size="lg">Event Triggers</Badge>
                <IconArrowRight size={16} color={colors.text.tertiary} />
                <Badge variant="filled" color="violet" size="lg">{selectedWorker.name}</Badge>
                <IconArrowRight size={16} color={colors.text.tertiary} />
                <Badge variant="light" color="green" size="lg">Output Events</Badge>
              </Group>
            </div>

            <Divider />

            <div>
              <Text size="sm" fw={600} mb="xs">Metadata</Text>
              <ScrollArea style={{ maxHeight: 200 }}>
                <Code block>{JSON.stringify(selectedWorker, null, 2)}</Code>
              </ScrollArea>
            </div>
          </Stack>
        )}
      </Drawer>

      {/* Create Webhook Modal */}
      <Modal 
        opened={createModalOpen} 
        onClose={() => setCreateModalOpen(false)} 
        title="Add Webhook"
      >
        <Stack gap="sm">
          <TextInput 
            label="Name" 
            placeholder="My Integration" 
            value={newWebhook.name}
            onChange={(e) => setNewWebhook({...newWebhook, name: e.target.value})}
          />
          <TextInput 
            label="Endpoint URL" 
            placeholder="https://api.example.com/webhook" 
            value={newWebhook.url}
            onChange={(e) => setNewWebhook({...newWebhook, url: e.target.value})}
          />
          <MultiSelect
            label="Event Types"
            placeholder="Select events"
            data={capabilities?.eventTypes?.map((et: any) => et.type) || []}
            value={newWebhook.eventTypes}
            onChange={(val) => setNewWebhook({...newWebhook, eventTypes: val})}
            searchable
          />
          <Button fullWidth onClick={() => createMutation.mutate(newWebhook)} loading={createMutation.isPending}>
            Create Webhook
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}
