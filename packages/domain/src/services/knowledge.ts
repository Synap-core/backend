import { knowledgeRepository } from '@synap/database';
import {
  KnowledgeFactSchema,
  RecordKnowledgeFactInputSchema,
  SearchKnowledgeFactsInputSchema,
  type KnowledgeFact,
  type RecordKnowledgeFactInput,
  type SearchKnowledgeFactsInput,
} from '../types.js';

export class KnowledgeService {
  constructor(private readonly repo = knowledgeRepository) {}

  async recordFact(input: RecordKnowledgeFactInput): Promise<KnowledgeFact> {
    const parsed = RecordKnowledgeFactInputSchema.parse(input);

    const record = await this.repo.saveFact({
      userId: parsed.userId,
      fact: parsed.fact,
      confidence: parsed.confidence,
      sourceEntityId: parsed.sourceEntityId,
      sourceMessageId: parsed.sourceMessageId,
      embedding: parsed.embedding,
    });

    return KnowledgeFactSchema.parse(record);
  }

  async searchFacts(input: SearchKnowledgeFactsInput): Promise<KnowledgeFact[]> {
    const parsed = SearchKnowledgeFactsInputSchema.parse(input);
    const records = await this.repo.searchFacts({
      userId: parsed.userId,
      query: parsed.query,
      limit: parsed.limit,
    });

    return records.map((record) => KnowledgeFactSchema.parse(record));
  }
}

export const knowledgeService = new KnowledgeService();




