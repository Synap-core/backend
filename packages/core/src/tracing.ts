/**
 * OpenTelemetry Distributed Tracing Configuration
 *
 * This module initializes OpenTelemetry instrumentation for:
 * - HTTP/HTTPS (incoming and outgoing requests)
 * - Hono (web framework)
 * - PostgreSQL (pg driver)
 * - Inngest (background jobs)
 * - DNS, Net, FS (I/O operations)
 *
 * IMPORTANT: This must be imported BEFORE any other application code
 * to ensure all libraries are properly instrumented.
 *
 * Usage:
 * ```typescript
 * // At the very top of your entry file (e.g., apps/api/src/index.ts)
 * import { initializeTracing } from '@synap-core/core';
 * initializeTracing();
 *
 * // Then import the rest of your application
 * import { Hono } from 'hono';
 * // ...
 * ```
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing
 *
 * Environment Variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP collector endpoint (default: http://localhost:4318)
 * - OTEL_EXPORTER_OTLP_HEADERS: Custom headers (e.g., for auth tokens)
 * - OTEL_SERVICE_NAME: Service name (default: 'synap-api')
 * - OTEL_SERVICE_VERSION: Service version (default: '1.0.0')
 * - NODE_ENV: Environment (development, production, etc.)
 * - OTEL_TRACES_ENABLED: Enable/disable tracing (default: true in production, false in dev)
 * - OTEL_LOG_LEVEL: Diagnostic log level (default: 'error')
 *
 * Supports all major observability platforms:
 * - Datadog: Set OTEL_EXPORTER_OTLP_ENDPOINT to Datadog Agent endpoint
 * - Honeycomb: Set endpoint + OTEL_EXPORTER_OTLP_HEADERS with API key
 * - Jaeger: Set endpoint to Jaeger OTLP collector
 * - Local development: Use Jaeger All-in-One for visualization
 */
export function initializeTracing(): void {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  // Tracing enabled by default in production, opt-in for development
  const tracesEnabled = process.env.OTEL_TRACES_ENABLED
    ? process.env.OTEL_TRACES_ENABLED === 'true'
    : isProduction;

  if (!tracesEnabled) {
    console.log('⚠️  OpenTelemetry tracing is disabled');
    return;
  }

  // Enable diagnostic logging for troubleshooting
  const diagLogLevel = process.env.OTEL_LOG_LEVEL || 'error';
  const diagLevelMap: Record<string, DiagLogLevel> = {
    'none': DiagLogLevel.NONE,
    'error': DiagLogLevel.ERROR,
    'warn': DiagLogLevel.WARN,
    'info': DiagLogLevel.INFO,
    'debug': DiagLogLevel.DEBUG,
    'verbose': DiagLogLevel.VERBOSE,
    'all': DiagLogLevel.ALL,
  };
  diag.setLogger(new DiagConsoleLogger(), diagLevelMap[diagLogLevel] || DiagLogLevel.ERROR);

  // Service identification via environment variables
  // These will be picked up by the SDK's auto-detection
  process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'synap-api';
  process.env.OTEL_SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || '1.0.0';

  const serviceName = process.env.OTEL_SERVICE_NAME;
  const serviceVersion = process.env.OTEL_SERVICE_VERSION;

  // OTLP Exporter configuration
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const otlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS
    ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    : {};

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: otlpHeaders,
  });

  // Create span processor (batch for better performance)
  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
  });

  // Initialize SDK with auto-instrumentation
  // SDK will auto-detect service name and version from env vars
  sdk = new NodeSDK({
    spanProcessor,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          ignoreIncomingRequestHook: (req) => {
            const url = req.url || '';
            return url.includes('/health') || url.includes('/metrics');
          },
        },
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-dns': { enabled: true },
        '@opentelemetry/instrumentation-net': { enabled: true },
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-express': { enabled: false },
        '@opentelemetry/instrumentation-mongodb': { enabled: false },
        '@opentelemetry/instrumentation-redis': { enabled: false },
        '@opentelemetry/instrumentation-mysql': { enabled: false },
      }),
    ],
  });

  sdk.start();

  console.log(`✅ OpenTelemetry tracing initialized`);
  console.log(`   Service: ${serviceName} v${serviceVersion}`);
  console.log(`   Environment: ${nodeEnv}`);
  console.log(`   OTLP Endpoint: ${otlpEndpoint}`);

  process.on('SIGTERM', async () => {
    try {
      await sdk?.shutdown();
      console.log('✅ OpenTelemetry SDK shut down successfully');
    } catch (error) {
      console.error('❌ Error shutting down OpenTelemetry SDK:', error);
    }
  });
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

export function isTracingInitialized(): boolean {
  return sdk !== null;
}
