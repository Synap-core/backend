import {
  Container,
  Title,
  Text,
  Stack,
  Alert,
  Loader,
  Grid,
  Card,
  Table,
} from '@mantine/core';
import { IconInfoCircle, IconAlertCircle } from '@tabler/icons-react';
import { trpc } from '../lib/trpc';
import FlowDiagram from '../components/architecture/FlowDiagram';

export default function ArchitectureVisualizerPage() {
  const { data, isLoading, error } = trpc.system.getCapabilities.useQuery();

  if (isLoading) {
    return (
      <Container size="xl">
        <Stack align="center" justify="center" h={400}>
          <Loader size="lg" />
          <Text c="dimmed">Loading architecture...</Text>
        </Stack>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red">
          Failed to load architecture: {(error as Error).message}
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
          <Title order={1}>Event Flow Architecture Visualizer</Title>
          <Text size="sm" c="dimmed">
            Living documentation of your event-driven architecture
          </Text>
        </div>

        <Alert icon={<IconInfoCircle size={16} />} title="Architecture Overview" color="blue">
          This diagram shows how events flow through your system: <strong>Events</strong> (blue
          circles) are handled by <strong>Event Handlers</strong> (green rectangles), which may
          invoke <strong>AI Tools</strong> (orange diamonds).
        </Alert>

        {/* Flow Diagram */}
        <FlowDiagram capabilities={data} />

        {/* Architecture Summary Tables */}
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder padding="md">
              <Title order={4} mb="md">
                Event Types Summary
              </Title>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Event Type</Table.Th>
                    <Table.Th>Handler Count</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.handlers.map((handler) => (
                    <Table.Tr key={handler.eventType}>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {handler.eventType}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{handler.handlers.length}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder padding="md">
              <Title order={4} mb="md">
                AI Tools Summary
              </Title>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Tool Name</Table.Th>
                    <Table.Th>Version</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.tools.map((tool) => (
                    <Table.Tr key={tool.name}>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {tool.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {tool.version}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Grid.Col>
        </Grid>

        {/* Handler Details */}
        <Card withBorder padding="md">
          <Title order={4} mb="md">
            Event Handler Details
          </Title>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Event Type</Table.Th>
                <Table.Th>Handler Class</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.handlers.flatMap((handler) =>
                handler.handlers.map((h, idx) => (
                  <Table.Tr key={`${handler.eventType}-${idx}`}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" c="blue">
                        {handler.eventType}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace" c="green">
                        {h.name}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </Card>
      </Stack>
    </Container>
  );
}
