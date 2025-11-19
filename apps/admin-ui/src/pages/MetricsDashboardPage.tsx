import {
  Container,
  Title,
  Text,
  Stack,
  Grid,
  Alert,
  Loader,
  Group,
  Badge,
  Card,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconAlertCircle,
  IconActivityHeartbeat,
  IconRefresh,
} from '@tabler/icons-react';
import { useMetrics } from '../hooks/useMetrics';
import MetricCard from '../components/metrics/MetricCard';
import TimeSeriesChart from '../components/metrics/TimeSeriesChart';
import { useEffect, useState } from 'react';

export default function MetricsDashboardPage() {
  const { currentMetrics, metricsHistory, isLoading, error } = useMetrics(5000); // Poll every 5 seconds
  const [rates, setRates] = useState({
    eventsPerSecond: 0,
    requestsPerSecond: 0,
    avgEventProcessingMs: 0,
    avgRequestDurationMs: 0,
  });

  // Calculate rates from the last two snapshots
  useEffect(() => {
    if (metricsHistory.length < 2) return;

    const current = metricsHistory[metricsHistory.length - 1];
    const previous = metricsHistory[metricsHistory.length - 2];
    const timeDiffSeconds = (current.timestamp - previous.timestamp) / 1000;

    const eventsDiff = current.eventsPublishedTotal - previous.eventsPublishedTotal;
    const requestsDiff = current.httpRequestsTotal - previous.httpRequestsTotal;

    setRates({
      eventsPerSecond: timeDiffSeconds > 0 ? eventsDiff / timeDiffSeconds : 0,
      requestsPerSecond: timeDiffSeconds > 0 ? requestsDiff / timeDiffSeconds : 0,
      avgEventProcessingMs: current.eventProcessingDurationMs,
      avgRequestDurationMs: current.httpRequestDurationMs,
    });
  }, [metricsHistory]);

  // Prepare time series data for charts
  const eventTimeSeriesData = metricsHistory.map((snapshot) => ({
    timestamp: snapshot.timestamp,
    published: snapshot.eventsPublishedTotal,
    processed: snapshot.eventsProcessedTotal,
  }));

  const httpTimeSeriesData = metricsHistory.map((snapshot) => ({
    timestamp: snapshot.timestamp,
    requests: snapshot.httpRequestsTotal,
    duration: snapshot.httpRequestDurationMs,
  }));

  const databaseTimeSeriesData = metricsHistory.map((snapshot) => ({
    timestamp: snapshot.timestamp,
    queries: snapshot.databaseQueriesTotal,
    duration: snapshot.databaseQueryDurationMs,
  }));

  if (isLoading && !currentMetrics) {
    return (
      <Container size="xl">
        <Stack align="center" justify="center" h={400}>
          <Loader size="lg" />
          <Text c="dimmed">Loading metrics...</Text>
        </Stack>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red">
          Failed to load metrics: {error}
        </Alert>
      </Container>
    );
  }

  if (!currentMetrics) {
    return null;
  }

  return (
    <Container size="xl">
      <Stack gap="xl">
        <Group justify="space-between">
          <div>
            <Title order={1}>Real-time Metrics Dashboard</Title>
            <Text size="sm" c="dimmed">
              System performance and health monitoring
            </Text>
          </div>
          <Group>
            <Badge
              variant="light"
              color="green"
              leftSection={<IconActivityHeartbeat size={14} />}
              size="lg"
            >
              Live
            </Badge>
            <Badge variant="outline" leftSection={<IconRefresh size={14} />}>
              Updates every 5s
            </Badge>
          </Group>
        </Group>

        <Alert icon={<IconInfoCircle size={16} />} title="Real-time Monitoring" color="blue">
          Metrics are collected from Prometheus endpoints and updated every 5 seconds. All rates
          are calculated in real-time.
        </Alert>

        {/* Key Performance Indicators */}
        <div>
          <Title order={3} mb="md">
            Key Performance Indicators
          </Title>
          <Grid>
            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <MetricCard
                title="Events/Second"
                value={rates.eventsPerSecond.toFixed(2)}
                unit="events/s"
                color="blue"
                description="Event publishing rate"
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <MetricCard
                title="Requests/Second"
                value={rates.requestsPerSecond.toFixed(2)}
                unit="req/s"
                color="green"
                description="HTTP request rate"
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <MetricCard
                title="Event Processing"
                value={rates.avgEventProcessingMs.toFixed(0)}
                unit="ms"
                color="orange"
                description="Average processing time"
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <MetricCard
                title="HTTP Latency"
                value={rates.avgRequestDurationMs.toFixed(0)}
                unit="ms"
                color="violet"
                description="Average request duration"
              />
            </Grid.Col>
          </Grid>
        </div>

        {/* System Metrics */}
        <div>
          <Title order={3} mb="md">
            System Metrics
          </Title>
          <Grid>
            <Grid.Col span={{ base: 12, sm: 6, md: 4 }}>
              <MetricCard
                title="WebSocket Connections"
                value={currentMetrics.websocketConnectionsActive}
                color="cyan"
                description="Active real-time connections"
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6, md: 4 }}>
              <MetricCard
                title="AI Tool Executions"
                value={currentMetrics.aiToolExecutionsTotal}
                color="pink"
                description="Total AI tool calls"
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6, md: 4 }}>
              <MetricCard
                title="AI Tokens Used"
                value={currentMetrics.aiTokensUsedTotal.toLocaleString()}
                color="grape"
                description="Total tokens consumed"
              />
            </Grid.Col>
          </Grid>
        </div>

        {/* Time Series Charts */}
        {metricsHistory.length > 1 && (
          <>
            <TimeSeriesChart
              title="Event Metrics"
              data={eventTimeSeriesData}
              metrics={[
                { key: 'published', label: 'Published', color: '#228BE6' },
                { key: 'processed', label: 'Processed', color: '#40C057' },
              ]}
            />

            <TimeSeriesChart
              title="HTTP Request Metrics"
              data={httpTimeSeriesData}
              metrics={[
                { key: 'requests', label: 'Total Requests', color: '#12B886' },
                { key: 'duration', label: 'Avg Duration (ms)', color: '#FD7E14' },
              ]}
            />

            <TimeSeriesChart
              title="Database Metrics"
              data={databaseTimeSeriesData}
              metrics={[
                { key: 'queries', label: 'Total Queries', color: '#7950F2' },
                { key: 'duration', label: 'Avg Duration (ms)', color: '#F06595' },
              ]}
            />
          </>
        )}

        {/* Raw Metrics Card */}
        <Card withBorder padding="md">
          <Title order={4} mb="md">
            Raw Metrics (Current Snapshot)
          </Title>
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Stack gap="xs">
                <Text size="sm">
                  <strong>HTTP Requests Total:</strong> {currentMetrics.httpRequestsTotal}
                </Text>
                <Text size="sm">
                  <strong>Events Published Total:</strong> {currentMetrics.eventsPublishedTotal}
                </Text>
                <Text size="sm">
                  <strong>Events Processed Total:</strong> {currentMetrics.eventsProcessedTotal}
                </Text>
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Stack gap="xs">
                <Text size="sm">
                  <strong>Database Queries Total:</strong> {currentMetrics.databaseQueriesTotal}
                </Text>
                <Text size="sm">
                  <strong>WebSocket Connections:</strong>{' '}
                  {currentMetrics.websocketConnectionsActive}
                </Text>
                <Text size="sm">
                  <strong>Last Updated:</strong> {new Date(currentMetrics.timestamp).toLocaleTimeString()}
                </Text>
              </Stack>
            </Grid.Col>
          </Grid>
        </Card>
      </Stack>
    </Container>
  );
}
