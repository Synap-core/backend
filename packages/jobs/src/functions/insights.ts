import { inngest } from '../client.js';
import { suggestionService } from '@synap/domain';

const HOURS_WINDOW = 24;
const MIN_USAGE_THRESHOLD = 3;

export const insightPatternDetector = inngest.createFunction(
  {
    id: 'insight-pattern-detector',
    name: 'Insight Pattern Detector',
  },
  {
    cron: '0 * * * *',
  },
  async ({ step }: { step: unknown }) => {
    const runStep = async <T>(name: string, handler: () => Promise<T>): Promise<T> => {
      if (typeof (step as any)?.run === 'function') {
        return (step as any).run(name, handler);
      }
      return handler();
    };

    const candidates = await runStep('load-tag-usage', async () =>
      suggestionService.getRecentTagUsage(HOURS_WINDOW, MIN_USAGE_THRESHOLD)
    );

    if (candidates.length === 0) {
      return { status: 'no-suggestions' };
    }

    let created = 0;

    for (const candidate of candidates) {
      const { tagId, userId, tagName, usageCount } = candidate;

      // Skip if tag already linked to a project
      const hasProject = await runStep(
        `check-projects-${tagId}`,
        () => suggestionService.hasProjectForTag(tagId)
      );

      if (hasProject) {
        continue;
      }

      // Avoid duplicate pending suggestions for the same tag
      const existing = await suggestionService.findPendingProposeProjectSuggestion({
        userId,
        tagId,
      });

      if (existing) {
        continue;
      }

      const relatedEntities = await runStep(
        `load-related-entities-${tagId}`,
        () => suggestionService.getRelatedEntitiesForTag(tagId, 5)
      );

      const confidence = Math.min(0.95, 0.2 + usageCount / 10);

      await suggestionService.createProposeProjectSuggestion({
        userId,
        tagId,
        tagName,
        usageCount,
        timeRangeHours: HOURS_WINDOW,
        relatedEntities,
        confidence,
      });

      created += 1;
    }

    return {
      status: created > 0 ? 'suggestions-created' : 'no-new-suggestions',
      created,
      inspected: candidates.length,
    };
  }
);


