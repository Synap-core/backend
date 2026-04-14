/**
 * IFeedScheduler Interface
 *
 * Defines the contract for scheduling and managing feed fetch jobs.
 * Implementations handle recurring feed fetches, job persistence, and execution.
 */

import type {
  ScheduledFeedJob,
  SchedulerConfig,
  FeedFetchResult,
} from "../types/index.js";
import type { FeedSourceConfig } from "../types/index.js";

/**
 * Feed scheduler interface
 *
 * Schedulers manage the timing and execution of feed fetch jobs.
 * They handle recurrence, retries, and job state persistence.
 */
export interface IFeedScheduler {
  /**
   * Schedule a new feed fetch job
   *
   * Creates a recurring job to fetch a feed on a schedule.
   *
   * @param feedConfigId - Unique identifier for the feed configuration
   * @param source - Feed source configuration
   * @param schedule - Cron expression for recurrence
   * @param timezone - Timezone for scheduling
   * @returns Promise resolving to the scheduled job
   *
   * @example
   * ```typescript
   * const job = await scheduler.schedule(
   *   "feed-123",
   *   { url: "https://example.com/feed.xml", provider: { type: "direct" } },
   *   "0 0/6 * * *",
   *   "America/New_York"
   * );
   * ```
   */
  schedule(
    feedConfigId: string,
    source: FeedSourceConfig,
    schedule: string,
    timezone: string
  ): Promise<ScheduledFeedJob>;

  /**
   * Cancel a scheduled job
   *
   * Stops a job from running and removes it from the schedule.
   *
   * @param jobId - ID of the job to cancel
   * @returns Promise resolving to true if cancelled successfully
   */
  cancel(jobId: string): Promise<boolean>;

  /**
   * Execute a job immediately
   *
   * Runs a scheduled job outside of its normal schedule.
   *
   * @param jobId - ID of the job to execute
   * @returns Promise resolving to the fetch result
   */
  executeNow(jobId: string): Promise<FeedFetchResult>;

  /**
   * Get a scheduled job by ID
   *
   * @param jobId - ID of the job to retrieve
   * @returns Promise resolving to the job or null if not found
   */
  getJob(jobId: string): Promise<ScheduledFeedJob | null>;

  /**
   * List all scheduled jobs
   *
   * @param filter - Optional filter criteria
   * @returns Promise resolving to array of scheduled jobs
   */
  listJobs(filter?: {
    feedConfigId?: string;
    isActive?: boolean;
    workspaceId?: string;
  }): Promise<ScheduledFeedJob[]>;

  /**
   * Get jobs that are due for execution
   *
   * @returns Promise resolving to array of jobs ready to run
   */
  getDueJobs(): Promise<ScheduledFeedJob[]>;

  /**
   * Update job configuration
   *
   * Modifies the schedule or other properties of an existing job.
   *
   * @param jobId - ID of the job to update
   * @param updates - Properties to update
   * @returns Promise resolving to the updated job
   */
  updateJob(
    jobId: string,
    updates: Partial<
      Pick<ScheduledFeedJob, "schedule" | "timezone" | "isActive">
    >
  ): Promise<ScheduledFeedJob>;

  /**
   * Get scheduler configuration
   *
   * @returns Current scheduler configuration
   */
  getConfig(): SchedulerConfig;

  /**
   * Get the scheduler type identifier
   *
   * @returns Scheduler type string
   */
  getSchedulerType(): string;
}
