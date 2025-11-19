import { Card, Title, Text, Stack, SegmentedControl, Group } from '@mantine/core';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useState } from 'react';
import { format } from 'date-fns';

interface DataPoint {
  timestamp: number;
  [key: string]: number;
}

interface TimeSeriesChartProps {
  title: string;
  data: DataPoint[];
  metrics: Array<{
    key: string;
    label: string;
    color: string;
  }>;
  timeRange?: '5m' | '15m' | '1h' | '6h';
  onTimeRangeChange?: (range: '5m' | '15m' | '1h' | '6h') => void;
}

export default function TimeSeriesChart({
  title,
  data,
  metrics,
  timeRange = '15m',
  onTimeRangeChange,
}: TimeSeriesChartProps) {
  const [selectedTimeRange, setSelectedTimeRange] = useState(timeRange);

  const handleTimeRangeChange = (value: string) => {
    const range = value as '5m' | '15m' | '1h' | '6h';
    setSelectedTimeRange(range);
    if (onTimeRangeChange) {
      onTimeRangeChange(range);
    }
  };

  const formatXAxis = (timestamp: number) => {
    return format(new Date(timestamp), 'HH:mm:ss');
  };

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Title order={4}>{title}</Title>
            <Text size="sm" c="dimmed">
              Real-time metrics over time
            </Text>
          </div>
          <SegmentedControl
            value={selectedTimeRange}
            onChange={handleTimeRangeChange}
            data={[
              { label: '5m', value: '5m' },
              { label: '15m', value: '15m' },
              { label: '1h', value: '1h' },
              { label: '6h', value: '6h' },
            ]}
            size="xs"
          />
        </Group>

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e9ecef" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatXAxis}
              stroke="#868e96"
              style={{ fontSize: '12px' }}
            />
            <YAxis stroke="#868e96" style={{ fontSize: '12px' }} />
            <Tooltip
              labelFormatter={(timestamp) => format(new Date(timestamp as number), 'HH:mm:ss')}
              contentStyle={{
                backgroundColor: '#fff',
                border: '1px solid #dee2e6',
                borderRadius: '4px',
                fontSize: '12px',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {metrics.map((metric) => (
              <Line
                key={metric.key}
                type="monotone"
                dataKey={metric.key}
                name={metric.label}
                stroke={metric.color}
                strokeWidth={2}
                dot={false}
                animationDuration={300}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Stack>
    </Card>
  );
}
