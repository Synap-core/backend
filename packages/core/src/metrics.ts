/**
 * Prometheus Metrics for Production Monitoring
 *
 * Provides essential metrics for:
 * - HTTP request duration and rate
 * - HTTP status codes distribution
 * - Event processing metrics
 * - Database query performance
 * - WebSocket connections
 * - Custom business metrics
 *
 * Metrics are exposed via /metrics endpoint for scraping by Prometheus
 *
 * Environment Variables:
 * - METRICS_ENABLED: Enable/disable metrics collection (default: true in production)
 * - METRICS_PREFIX: Prefix for all metrics (default: 'synap_')
 * - METRICS_DEFAULT_LABELS: JSON object with default labels (e.g., '{"env":"production"}')
 */

import client from "prom-client";

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

// Metrics enabled by default in production, opt-in for development
const metricsEnabled = process.env.METRICS_ENABLED
  ? process.env.METRICS_ENABLED === "true"
  : isProduction;

const metricsPrefix = process.env.METRICS_PREFIX || "synap_";

// Create registry
export const register = new client.Registry();

// Add default labels (env, service, version)
const defaultLabels = process.env.METRICS_DEFAULT_LABELS
  ? JSON.parse(process.env.METRICS_DEFAULT_LABELS)
  : {
      env: nodeEnv,
      service: process.env.OTEL_SERVICE_NAME || "synap-api",
      version: process.env.OTEL_SERVICE_VERSION || "1.0.0",
    };

register.setDefaultLabels(defaultLabels);

// Enable default Node.js metrics (CPU, memory, event loop, etc.)
if (metricsEnabled) {
  client.collectDefaultMetrics({
    register,
    prefix: metricsPrefix,
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  });
}

/**
 * HTTP Request Metrics
 */

// HTTP request duration histogram
export const httpRequestDuration = new client.Histogram({
  name: `${metricsPrefix}http_request_duration_seconds`,
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// HTTP request counter
export const httpRequestTotal = new client.Counter({
  name: `${metricsPrefix}http_requests_total`,
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

// HTTP request size
export const httpRequestSize = new client.Histogram({
  name: `${metricsPrefix}http_request_size_bytes`,
  help: "Size of HTTP requests in bytes",
  labelNames: ["method", "route"],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [register],
});

// HTTP response size
export const httpResponseSize = new client.Histogram({
  name: `${metricsPrefix}http_response_size_bytes`,
  help: "Size of HTTP responses in bytes",
  labelNames: ["method", "route"],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [register],
});

/**
 * Event Processing Metrics
 */

// Events processed counter
export const eventsProcessed = new client.Counter({
  name: `${metricsPrefix}events_processed_total`,
  help: "Total number of events processed",
  labelNames: ["event_type", "status"], // status: success, error
  registers: [register],
});

// Event processing duration
export const eventProcessingDuration = new client.Histogram({
  name: `${metricsPrefix}event_processing_duration_seconds`,
  help: "Duration of event processing in seconds",
  labelNames: ["event_type", "handler"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

// Events in queue (gauge)
export const eventsInQueue = new client.Gauge({
  name: `${metricsPrefix}events_in_queue`,
  help: "Number of events currently in the processing queue",
  labelNames: ["event_type"],
  registers: [register],
});

/**
 * Database Metrics
 */

// Database query duration
export const dbQueryDuration = new client.Histogram({
  name: `${metricsPrefix}db_query_duration_seconds`,
  help: "Duration of database queries in seconds",
  labelNames: ["operation", "table"], // operation: select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// Database query counter
export const dbQueryTotal = new client.Counter({
  name: `${metricsPrefix}db_queries_total`,
  help: "Total number of database queries",
  labelNames: ["operation", "table", "status"], // status: success, error
  registers: [register],
});

// Database connection pool
export const dbConnectionPool = new client.Gauge({
  name: `${metricsPrefix}db_connection_pool_size`,
  help: "Size of the database connection pool",
  labelNames: ["state"], // state: idle, active, waiting
  registers: [register],
});

/**
 * WebSocket / Realtime Metrics
 */

// Active WebSocket connections
export const websocketConnections = new client.Gauge({
  name: `${metricsPrefix}websocket_connections_active`,
  help: "Number of active WebSocket connections",
  labelNames: ["room_type"], // room_type: user, request
  registers: [register],
});

// WebSocket messages sent
export const websocketMessagesSent = new client.Counter({
  name: `${metricsPrefix}websocket_messages_sent_total`,
  help: "Total number of WebSocket messages sent",
  labelNames: ["message_type", "room_type"],
  registers: [register],
});

// WebSocket message broadcast duration
export const websocketBroadcastDuration = new client.Histogram({
  name: `${metricsPrefix}websocket_broadcast_duration_seconds`,
  help: "Duration of WebSocket broadcast operations",
  labelNames: ["room_type"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [register],
});

/**
 * Inngest / Background Job Metrics
 */

// Jobs processed
export const jobsProcessed = new client.Counter({
  name: `${metricsPrefix}jobs_processed_total`,
  help: "Total number of background jobs processed",
  labelNames: ["job_name", "status"], // status: success, failure, retry
  registers: [register],
});

// Job processing duration
export const jobProcessingDuration = new client.Histogram({
  name: `${metricsPrefix}job_processing_duration_seconds`,
  help: "Duration of background job processing",
  labelNames: ["job_name"],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// Jobs waiting in queue
export const jobsWaiting = new client.Gauge({
  name: `${metricsPrefix}jobs_waiting_in_queue`,
  help: "Number of jobs waiting to be processed",
  labelNames: ["job_name"],
  registers: [register],
});

/**
 * AI / LLM Metrics
 */

// AI requests
export const aiRequests = new client.Counter({
  name: `${metricsPrefix}ai_requests_total`,
  help: "Total number of AI/LLM API requests",
  labelNames: ["provider", "model", "status"], // provider: anthropic, openai
  registers: [register],
});

// AI request duration
export const aiRequestDuration = new client.Histogram({
  name: `${metricsPrefix}ai_request_duration_seconds`,
  help: "Duration of AI/LLM API requests",
  labelNames: ["provider", "model"],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [register],
});

// AI tokens used
export const aiTokensUsed = new client.Counter({
  name: `${metricsPrefix}ai_tokens_used_total`,
  help: "Total number of AI/LLM tokens used",
  labelNames: ["provider", "model", "token_type"], // token_type: input, output
  registers: [register],
});

/**
 * Storage Metrics
 */

// Storage operations
export const storageOperations = new client.Counter({
  name: `${metricsPrefix}storage_operations_total`,
  help: "Total number of storage operations",
  labelNames: ["operation", "provider", "status"], // operation: upload, download, delete
  registers: [register],
});

// Storage operation duration
export const storageOperationDuration = new client.Histogram({
  name: `${metricsPrefix}storage_operation_duration_seconds`,
  help: "Duration of storage operations",
  labelNames: ["operation", "provider"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Storage bytes transferred
export const storageBytesTransferred = new client.Counter({
  name: `${metricsPrefix}storage_bytes_transferred_total`,
  help: "Total bytes transferred to/from storage",
  labelNames: ["operation", "provider"], // operation: upload, download
  registers: [register],
});

/**
 * Business Metrics
 */

// Users active
export const usersActive = new client.Gauge({
  name: `${metricsPrefix}users_active`,
  help: "Number of currently active users",
  registers: [register],
});

// Notes created
export const notesCreated = new client.Counter({
  name: `${metricsPrefix}notes_created_total`,
  help: "Total number of notes created",
  labelNames: ["source"], // source: capture, upload, manual
  registers: [register],
});

// Conversations started
export const conversationsStarted = new client.Counter({
  name: `${metricsPrefix}conversations_started_total`,
  help: "Total number of conversations started",
  registers: [register],
});

/**
 * Error Metrics
 */

// Application errors
export const applicationErrors = new client.Counter({
  name: `${metricsPrefix}application_errors_total`,
  help: "Total number of application errors",
  labelNames: ["error_type", "severity"], // severity: warning, error, fatal
  registers: [register],
});

/**
 * Get metrics in Prometheus format
 *
 * @returns Promise<string> Metrics in Prometheus exposition format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get metrics as JSON (for debugging)
 *
 * @returns Promise<object> Metrics as JSON
 */
export async function getMetricsJSON(): Promise<any> {
  return register.getMetricsAsJSON();
}

/**
 * Reset all metrics (for testing)
 */
export function resetMetrics(): void {
  register.resetMetrics();
}

/**
 * Check if metrics collection is enabled
 */
export function isMetricsEnabled(): boolean {
  return metricsEnabled;
}
