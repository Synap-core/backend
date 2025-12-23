/**
 * Event Types
 */

export interface Event {
  id: string;
  timestamp: Date;
  type: string;
  subjectId: string;
  subjectType: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source: string;
  correlationId?: string;
  userId: string;
}

export interface EventFilter {
  subjectId?: string;
  subjectType?: string;
  eventTypes?: string[];
  limit?: number;
  after?: Date;
  before?: Date;
}
