import { Container, Title, Text, Card, Stack, Table, Badge, Group, Loader, Alert } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { trpc } from '../lib/trpc';

export default function CapabilitiesPage() {
  const { data, isLoading, error } = trpc.system.getCapabilities.useQuery();

  if (isLoading) {
    return (
      <Container size="xl">
        <Stack align="center" justify="center" h={400}>
          <Loader size="lg" />
          <Text c="dimmed">Loading system capabilities...</Text>
        </Stack>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="xl">
        <Alert icon={<IconInfoCircle size={16} />} title="Error" color="red">
          Failed to load system capabilities: {error.message}
        </Alert>
      </Container>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <Container size="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>System Capabilities</Title>
          <Text size="sm" c="dimmed">
            Overview of all registered components in the Synap ecosystem
          </Text>
        </div>

        {/* Statistics Cards */}
        <Group grow>
          <Card withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Event Types
            </Text>
            <Text size="xl" fw={700}>
              {data.stats.totalEventTypes}
            </Text>
          </Card>
          <Card withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Event Handlers
            </Text>
            <Text size="xl" fw={700}>
              {data.stats.totalHandlers}
            </Text>
          </Card>
          <Card withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              AI Tools
            </Text>
            <Text size="xl" fw={700}>
              {data.stats.totalTools}
            </Text>
          </Card>
          <Card withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              API Routers
            </Text>
            <Text size="xl" fw={700}>
              {data.stats.totalRouters}
            </Text>
          </Card>
          <Card withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              SSE Clients
            </Text>
            <Text size="xl" fw={700}>
              {data.stats.connectedSSEClients}
            </Text>
          </Card>
        </Group>

        {/* Event Types */}
        <Card withBorder>
          <Title order={3} mb="md">
            Event Types
          </Title>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Event Type</Table.Th>
                <Table.Th>Has Schema</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.eventTypes.map((et) => (
                <Table.Tr key={et.type}>
                  <Table.Td>
                    <Badge variant="light">{et.type}</Badge>
                  </Table.Td>
                  <Table.Td>
                    {et.hasSchema ? (
                      <Badge color="green" variant="light">
                        Yes
                      </Badge>
                    ) : (
                      <Badge color="gray" variant="light">
                        No
                      </Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>

        {/* Event Handlers */}
        <Card withBorder>
          <Title order={3} mb="md">
            Event Handlers
          </Title>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Event Type</Table.Th>
                <Table.Th>Handler Class</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.handlers.map((handler) =>
                handler.handlers.map((h, idx) => (
                  <Table.Tr key={`${handler.eventType}-${idx}`}>
                    <Table.Td>
                      <Badge variant="light">{handler.eventType}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {h.name}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </Card>

        {/* AI Tools */}
        <Card withBorder>
          <Title order={3} mb="md">
            AI Tools
          </Title>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tool Name</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Source</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.tools.map((tool) => (
                <Table.Tr key={tool.name}>
                  <Table.Td>
                    <Text ff="monospace" fw={500}>
                      {tool.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {tool.description}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="outline">{tool.version}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={tool.source === 'core' ? 'blue' : 'gray'}>{tool.source}</Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>

        {/* API Routers */}
        <Card withBorder>
          <Title order={3} mb="md">
            API Routers
          </Title>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Router Name</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Source</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.routers.map((router) => (
                <Table.Tr key={router.name}>
                  <Table.Td>
                    <Text ff="monospace" fw={500}>
                      {router.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {router.description || 'No description'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="outline">{router.version}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={router.source === 'core' ? 'blue' : 'gray'}>
                      {router.source}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      </Stack>
    </Container>
  );
}
