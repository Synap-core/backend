# @synap/hub-orchestrator-base

Abstract base class and types for Hub Orchestrators.

## Installation

```bash
pnpm add @synap/hub-orchestrator-base
```

## Usage

### Extending the Base Class

```typescript
import { HubOrchestratorBase, type ExpertiseRequest, type ExpertiseResponse } from '@synap/hub-orchestrator-base';
import { HubProtocolClient } from '@synap/hub-protocol-client';

class MyCustomHub extends HubOrchestratorBase {
  private client: HubProtocolClient;

  constructor() {
    super();
    this.client = new HubProtocolClient({
      dataPodUrl: 'http://localhost:3000',
      token: 'user-session-token',
    });
  }

  async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
    try {
      // 1. Generate access token
      const { token } = await this.client.generateAccessToken(
        request.requestId,
        ['preferences', 'notes'],
        300
      );

      // 2. Retrieve data
      const data = await this.client.requestData(token, ['preferences', 'notes']);

      // 3. Process with your logic
      const insight = await this.processWithMyLogic(request.query, data);

      // 4. Submit insight
      await this.client.submitInsight(token, insight);

      return {
        requestId: request.requestId,
        status: 'completed',
        insight,
      };
    } catch (error) {
      return {
        requestId: request.requestId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async processWithMyLogic(query: string, data: any) {
    // Your custom processing logic
    return {
      version: '1.0',
      type: 'action_plan',
      // ...
    };
  }
}
```

## API Reference

### `HubOrchestratorBase`

Abstract base class that all Hub Orchestrators must extend.

#### Methods

##### `executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse>`

**Abstract method** that must be implemented by all Hub Orchestrators.

Orchestrates the complete flow:
1. Generate access token
2. Retrieve user data from Data Pod
3. Process with Hub-specific logic
4. Submit insight back to Data Pod

### Types

#### `ExpertiseRequest`

```typescript
interface ExpertiseRequest {
  requestId: string;
  userId: string;
  dataPodUrl: string;
  query: string;
  agentId?: string;
  context?: Record<string, unknown>;
}
```

#### `ExpertiseResponse`

```typescript
interface ExpertiseResponse {
  requestId: string;
  status: 'completed' | 'failed';
  insight?: HubInsight;
  error?: string;
}
```

### Errors

- `HubOrchestratorError` - Base error class
- `TokenGenerationError` - Token generation failed
- `DataRetrievalError` - Data retrieval failed
- `InsightSubmissionError` - Insight submission failed
- `AgentExecutionError` - Agent execution failed

## Dependencies

- `@synap/hub-protocol` - Hub Protocol schemas and types
- `@synap/hub-protocol-client` - Hub Protocol client

## License

MIT

