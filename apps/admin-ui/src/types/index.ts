/**
 * Common type definitions for the admin-ui application
 */

// Event-related types
export interface EventData {
  eventId: string;
  eventType: string;
  userId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

export interface EventTrace {
  event: EventData;
  relatedEvents?: EventData[];
}

// Tool execution types
export interface ToolExecutionInput {
  [key: string]: unknown;
}

export interface ToolExecutionOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ExecutionHistoryItem {
  id: string;
  timestamp: Date;
  type: 'tool' | 'event';
  name: string;
  input: ToolExecutionInput | Record<string, unknown>;
  output?: ToolExecutionInput | ToolExecutionOutput;
  error?: string;
  success: boolean;
}

// Publish event types
export interface PublishEventResult {
  success: boolean;
  data?: {
    eventId: string;
    [key: string]: unknown;
  };
  error?: string;
}

// System metrics types
export interface SystemMetrics {
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    errorRate: number;
  };
  throughput: {
    eventsPerSecond: number;
    totalEventsLast5Min: number;
  };
}

// Capabilities types
export interface Tool {
  name: string;
  description: string;
}

export interface Capabilities {
  tools: Tool[];
  eventTypes?: Array<{
    type: string;
    description?: string;
  }>;
}

// Error types
export interface ApiError {
  message: string;
  code?: string;
  statusCode?: number;
}

// Cytoscape types
export interface CytoscapeNode {
  data: {
    id: string;
    label: string;
    [key: string]: unknown;
  };
}

export interface CytoscapeEdge {
  data: {
    id: string;
    source: string;
    target: string;
    [key: string]: unknown;
  };
}

