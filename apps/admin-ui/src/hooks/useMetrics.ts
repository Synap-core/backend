import { useState, useEffect, useCallback } from "react";

interface MetricsSnapshot {
  timestamp: number;
  httpRequestsTotal: number;
  httpRequestDurationMs: number;
  eventsPublishedTotal: number;
  eventsProcessedTotal: number;
  eventProcessingDurationMs: number;
  websocketConnectionsActive: number;
  databaseQueriesTotal: number;
  databaseQueryDurationMs: number;
  aiToolExecutionsTotal: number;
  aiTokensUsedTotal: number;
}

interface ParsedMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
}

export function useMetrics(intervalMs: number = 5000) {
  const [currentMetrics, setCurrentMetrics] = useState<MetricsSnapshot | null>(
    null
  );
  const [metricsHistory, setMetricsHistory] = useState<MetricsSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parsePrometheusMetrics = useCallback((text: string): ParsedMetric[] => {
    const lines = text.split("\n");
    const metrics: ParsedMetric[] = [];

    for (const line of lines) {
      // Skip comments and empty lines
      if (line.startsWith("#") || line.trim() === "") continue;

      // Parse metric line: metric_name{label="value"} value
      const match = line.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)((?:\{[^}]*\})?) (.+)$/
      );
      if (!match) continue;

      const [, name, labelsStr, valueStr] = match;
      const value = parseFloat(valueStr);

      // Parse labels
      const labels: Record<string, string> = {};
      if (labelsStr) {
        const labelMatches = labelsStr.matchAll(
          /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g
        );
        for (const labelMatch of labelMatches) {
          labels[labelMatch[1]] = labelMatch[2];
        }
      }

      metrics.push({ name, value, labels });
    }

    return metrics;
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";
      const response = await fetch(`${API_URL}/metrics`);

      if (!response.ok) {
        throw new Error("Failed to fetch metrics");
      }

      const text = await response.text();
      const parsedMetrics = parsePrometheusMetrics(text);

      // Extract key metrics
      const snapshot: MetricsSnapshot = {
        timestamp: Date.now(),
        httpRequestsTotal:
          parsedMetrics.find((m) => m.name === "http_requests_total")?.value ||
          0,
        httpRequestDurationMs:
          parsedMetrics.find((m) => m.name === "http_request_duration_ms")
            ?.value || 0,
        eventsPublishedTotal:
          parsedMetrics.find((m) => m.name === "events_published_total")
            ?.value || 0,
        eventsProcessedTotal:
          parsedMetrics.find((m) => m.name === "events_processed_total")
            ?.value || 0,
        eventProcessingDurationMs:
          parsedMetrics.find((m) => m.name === "event_processing_duration_ms")
            ?.value || 0,
        websocketConnectionsActive:
          parsedMetrics.find((m) => m.name === "websocket_connections_active")
            ?.value || 0,
        databaseQueriesTotal:
          parsedMetrics.find((m) => m.name === "database_queries_total")
            ?.value || 0,
        databaseQueryDurationMs:
          parsedMetrics.find((m) => m.name === "database_query_duration_ms")
            ?.value || 0,
        aiToolExecutionsTotal:
          parsedMetrics.find((m) => m.name === "ai_tool_executions_total")
            ?.value || 0,
        aiTokensUsedTotal:
          parsedMetrics.find((m) => m.name === "ai_tokens_used_total")?.value ||
          0,
      };

      setCurrentMetrics(snapshot);
      setMetricsHistory((prev) => {
        const updated = [...prev, snapshot];
        // Keep last 100 snapshots
        return updated.slice(-100);
      });
      setError(null);
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsLoading(false);
    }
  }, [parsePrometheusMetrics]);

  useEffect(() => {
    // Initial fetch
    fetchMetrics();

    // Set up polling
    const interval = setInterval(fetchMetrics, intervalMs);

    return () => clearInterval(interval);
  }, [fetchMetrics, intervalMs]);

  return {
    currentMetrics,
    metricsHistory,
    isLoading,
    error,
    refetch: fetchMetrics,
  };
}
