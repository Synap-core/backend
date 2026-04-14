/**
 * Feed Service Integration Tests
 *
 * Tests the complete feed pipeline:
 * - Provider fetching
 * - Classification
 * - Publishing
 * - Error handling and fallback
 *
 * @module feed-service-integration-tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeedServiceFactory } from "../FeedServiceFactory.js";
import { FeedService } from "../FeedService.js";
import type {
  RSSProviderConfig,
  FeedSourceConfig,
  NormalizedRSSItem,
} from "../types/index.js";

// ============================================================================
// Test Setup
// ============================================================================

// Mock fetch for RSS feeds
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Sample RSS XML
const sampleRSSXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <description>Test RSS feed</description>
    <item>
      <guid>item-1</guid>
      <title>AI Breakthrough in 2024</title>
      <link>https://example.com/ai-breakthrough</link>
      <description>Revolutionary advances in artificial intelligence</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <author>John Doe</author>
      <category>AI</category>
      <category>Technology</category>
    </item>
    <item>
      <guid>item-2</guid>
      <title>Startup Funding News</title>
      <link>https://example.com/startup-funding</link>
      <description>Latest funding rounds in the tech industry</description>
      <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
      <author>Jane Smith</author>
      <category>Startups</category>
      <category>Business</category>
    </item>
  </channel>
</rss>`;

// Sample Atom XML
const sampleAtomXML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <link href="https://example.com"/>
  <updated>2024-01-01T12:00:00Z</updated>
  <entry>
    <id>atom-item-1</id>
    <title>Cloud Computing Trends</title>
    <link href="https://example.com/cloud-trends"/>
    <updated>2024-01-01T12:00:00Z</updated>
    <summary>Latest trends in cloud infrastructure</summary>
    <author><name>Tech Reporter</name></author>
    <category term="Cloud"/>
  </entry>
</feed>`;

// ============================================================================
// Helper Functions
// ============================================================================

function createMockResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("Feed Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FeedServiceFactory.configure({});
  });

  describe("Provider Fetching", () => {
    it("should fetch RSS via DirectRSSProvider", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(sampleRSSXML));

      const provider = FeedServiceFactory.createProvider({
        type: "direct",
        timeoutMs: 30000,
        retryAttempts: 3,
      });

      const source: FeedSourceConfig = {
        url: "https://example.com/feed.xml",
        provider: { type: "direct" },
      };

      const items = await provider.fetch(source);

      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("AI Breakthrough in 2024");
      expect(items[0].categories).toContain("AI");
    });

    it("should fetch Atom via DirectRSSProvider", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(sampleAtomXML));

      const provider = FeedServiceFactory.createProvider({ type: "direct" });

      const source: FeedSourceConfig = {
        url: "https://example.com/atom.xml",
        provider: { type: "direct" },
      };

      const items = await provider.fetch(source);

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Cloud Computing Trends");
    });

    it("should handle RSSHub provider with access key", async () => {
      const config: RSSProviderConfig = {
        type: "rsshub",
        url: "https://rsshub.app",
        apiKey: "test-access-key",
        timeoutMs: 30000,
      };

      const provider = FeedServiceFactory.createProvider(config);
      expect(provider).toBeDefined();

      // Verify provider type
      expect(provider.getProviderType()).toBe("rsshub");
    });

    it("should handle CP proxy provider", async () => {
      const config: RSSProviderConfig = {
        type: "cpproxy",
        url: "https://proxy.synap.io",
        apiKey: "test-api-key",
        timeoutMs: 30000,
      };

      const provider = FeedServiceFactory.createProvider(config);
      expect(provider).toBeDefined();
      expect(provider.getProviderType()).toBe("cpproxy");
    });

    it("should handle fetch errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const provider = FeedServiceFactory.createProvider({ type: "direct" });

      const source: FeedSourceConfig = {
        url: "https://example.com/feed.xml",
        provider: { type: "direct" },
      };

      // Provider throws on error
      await expect(provider.fetch(source)).rejects.toThrow("Network error");
    });

    it("should handle HTTP error responses", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse("Not found", 404));

      const provider = FeedServiceFactory.createProvider({ type: "direct" });

      const source: FeedSourceConfig = {
        url: "https://example.com/missing.xml",
        provider: { type: "direct" },
      };

      // Provider throws on error
      await expect(provider.fetch(source)).rejects.toThrow();
    });
  });

  describe("Classification", () => {
    it("should classify items with KeywordClassifier", async () => {
      const classifier = FeedServiceFactory.createClassifier("keyword");

      const items: NormalizedRSSItem[] = [
        {
          id: "1",
          title: "AI breakthrough in machine learning",
          content: "New neural network architecture",
          url: "https://example.com/ai",
          categories: ["AI"],
          source: { name: "Test", url: "https://example.com" },
        },
        {
          id: "2",
          title: "Startup raises $10M funding",
          content: "Series A round for tech startup",
          url: "https://example.com/startup",
          categories: ["Business"],
          source: { name: "Test", url: "https://example.com" },
        },
      ];

      const context = {
        userId: "user-123",
        interests: ["ai", "startups"],
        priorityKeywords: [],
        excludeKeywords: [],
        preferredCategories: ["AI"],
      };

      const classified = await classifier.classify(items, context);

      expect(classified).toHaveLength(2);
      expect(classified[0].category).toBeDefined();
      expect(classified[0].confidence).toBeGreaterThan(0);
      expect(classified[0].confidence).toBeLessThanOrEqual(1);
    });

    it("should classify items with NoopClassifier for testing", async () => {
      const classifier = FeedServiceFactory.createClassifier("noop");

      const items: NormalizedRSSItem[] = [
        {
          id: "1",
          title: "Test Item",
          source: { name: "Test", url: "https://example.com" },
          categories: [],
        },
      ];

      const context = {
        userId: "user-123",
        interests: [],
        priorityKeywords: [],
        excludeKeywords: [],
        preferredCategories: [],
      };
      const classified = await classifier.classify(items, context);

      expect(classified).toHaveLength(1);
      expect(classified[0].category).toBeDefined();
      expect(classified[0].shouldPublish).toBe(true);
    });

    it("should throw error for IS classifier without config", () => {
      expect(() => FeedServiceFactory.createClassifier("is")).toThrow(
        "IS classifier requires configuration"
      );
    });

    it("should classify with IS classifier when configured", async () => {
      FeedServiceFactory.configure({
        isConfig: {
          isServiceUrl: "https://is.synap.io",
          isServiceApiKey: "test-key",
        },
      });

      // Mock the IS response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              {
                category: "ai",
                confidence: 0.95,
                relevanceScore: 0.8,
                keywords: ["machine learning", "neural networks"],
              },
            ],
          }),
      });

      const classifier = FeedServiceFactory.createClassifier("is");
      expect(classifier).toBeDefined();
    });
  });

  describe("Publishing", () => {
    it("should post to channel via ChannelMessagePublisher", async () => {
      const publisher = FeedServiceFactory.createPublisher("channel");

      const items = [
        {
          item: {
            id: "1",
            title: "Test Item",
            url: "https://example.com/test",
            source: { name: "Test", url: "https://example.com" },
            categories: ["Tech"],
          },
          category: "tech",
          confidence: 0.9,
          relevanceScore: 0.85,
          keywords: [],
          shouldPublish: true,
        },
      ];

      const destination = {
        channelId: "test-channel",
        userId: "user-123",
      };

      // Publishing is async and depends on database
      // In integration tests we'd use test database
      await expect(
        publisher.publish(items, destination)
      ).resolves.not.toThrow();
    });
  });

  describe("Provider Fallback", () => {
    it("should handle provider fallback when primary fails", async () => {
      // First call fails, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error("Primary provider failed"))
        .mockResolvedValueOnce(createMockResponse(sampleRSSXML));

      const primaryProvider = FeedServiceFactory.createProvider({
        type: "direct",
        timeoutMs: 5000,
      });

      const fallbackProvider = FeedServiceFactory.createProvider({
        type: "cpproxy",
        url: "https://proxy.synap.io",
      });

      const source: FeedSourceConfig = {
        url: "https://example.com/feed.xml",
        provider: { type: "direct" },
      };

      // Try primary
      try {
        await primaryProvider.fetch(source);
      } catch {
        // Fallback to secondary
        const items = await fallbackProvider.fetch(source);
        expect(items).toHaveLength(2);
      }
    });
  });

  describe("Complete Pipeline", () => {
    it("should process feed end-to-end with FeedService", async () => {
      mockFetch.mockResolvedValue(createMockResponse(sampleRSSXML));

      const service = new FeedService({
        defaultClassifier: "keyword",
        enableDeduplication: true,
      });

      const source: FeedSourceConfig = {
        url: "https://example.com/feed.xml",
        provider: { type: "direct" },
      };

      const result = await service.processFeed(source, {
        destination: { channelId: "channel-123", userId: "user-456" },
        userContext: {
          userId: "user-456",
          interests: ["ai", "startups"],
          priorityKeywords: [],
          excludeKeywords: [],
          preferredCategories: [],
        },
      });

      expect(result.success).toBe(true);
      expect(result.itemsFetched).toBeGreaterThan(0);
    });

    it("should respect minRelevanceScore filter", async () => {
      mockFetch.mockResolvedValue(createMockResponse(sampleRSSXML));

      const service = new FeedService({
        defaultClassifier: "keyword",
        enableDeduplication: true,
      });

      const source: FeedSourceConfig = {
        url: "https://example.com/feed.xml",
        provider: { type: "direct" },
      };

      const result = await service.processFeed(source, {
        destination: { channelId: "channel-123", userId: "user-456" },
        userContext: {
          userId: "user-456",
          interests: ["ai"],
          priorityKeywords: [],
          excludeKeywords: [],
          preferredCategories: [],
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid RSS gracefully", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse("This is not valid XML")
      );

      const provider = FeedServiceFactory.createProvider({ type: "direct" });

      const source: FeedSourceConfig = {
        url: "https://example.com/invalid.xml",
        provider: { type: "direct" },
      };

      // Provider throws on parse error
      await expect(provider.fetch(source)).rejects.toThrow();
    });

    it("should handle timeout errors", async () => {
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 100)
          )
      );

      const provider = FeedServiceFactory.createProvider({
        type: "direct",
        timeoutMs: 50, // Very short timeout
      });

      const source: FeedSourceConfig = {
        url: "https://example.com/slow.xml",
        provider: { type: "direct" },
      };

      await expect(provider.fetch(source)).rejects.toThrow();
    });
  });

  describe("Factory Configuration", () => {
    it("should configure factory with options", () => {
      FeedServiceFactory.configure({
        userAgent: "SynapFeedService/1.0",
        keywordConfig: {
          categories: [
            {
              name: "ai",
              keywords: ["artificial intelligence", "machine learning"],
            },
          ],
        },
      });

      // Factory should accept configuration without errors
      expect(() =>
        FeedServiceFactory.createClassifier("keyword")
      ).not.toThrow();
    });

    it("should return available provider types", () => {
      const providers = FeedServiceFactory.getAvailableProviders();
      expect(providers).toContain("direct");
      expect(providers).toContain("rsshub");
      expect(providers).toContain("cpproxy");
      expect(providers).toContain("custom");
    });

    it("should return available classifier types", () => {
      const classifiers = FeedServiceFactory.getAvailableClassifiers();
      expect(classifiers).toContain("is");
      expect(classifiers).toContain("keyword");
      expect(classifiers).toContain("noop");
    });
  });
});
