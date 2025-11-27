# Guide Système de Plugins Data Pod

**Version**: 1.0  
**Public**: Développeurs de plugins pour le Data Pod  
**Objectif**: Comprendre comment créer et utiliser des plugins pour étendre le Data Pod

---

## 🎯 Principe : "Backdoor" pour Power Users

Le Data Pod reste **extensible via plugins** pour permettre aux power users de :

1. **Connecter leur propre Intelligence Hub** (ou autre service)
2. **Ajouter des plugins REST** (appels externes)
3. **Ajouter des plugins Agents** (LangGraph local)
4. **Ajouter des plugins API** (nouveaux endpoints tRPC)

**⚠️ Important** : Les plugins sont exécutés **dans le Data Pod** (open-source). Ils peuvent accéder aux données utilisateur via les APIs du Data Pod.

---

## 🏗️ Architecture

```
Data Pod (Open Source)
├── Core Routers (capture, notes, tasks, ...)
├── Hub Protocol (hub.*)
└── Plugin System
    ├── Plugin Manager
    ├── Plugin Registry
    └── Plugins
        ├── Intelligence Hub Plugin (exemple)
        ├── Custom REST Plugin (user)
        ├── Custom Agent Plugin (user)
        └── Custom API Plugin (user)
```

---

## 📋 Types de Plugins

### 1. **Plugin REST** (Appels Externes)

**Usage** : Appeler un service externe (Intelligence Hub, autre service, etc.)

**Exemple** : Plugin Intelligence Hub qui appelle l'Intelligence Hub Synap

```typescript
// plugins/intelligence-hub-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { HubProtocolClient } from '@synap/hub-protocol-client';

export const intelligenceHubPlugin: DataPodPlugin = {
  name: 'intelligence-hub',
  version: '1.0.0',
  enabled: process.env.INTELLIGENCE_HUB_ENABLED === 'true',
  
  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    const hubClient = new HubProtocolClient({
      dataPodUrl: process.env.INTELLIGENCE_HUB_URL!,
      getToken: async () => process.env.INTELLIGENCE_HUB_API_KEY!,
    });
    
    const result = await hubClient.requestExpertise({
      query: input.content,
      userId: input.userId,
      context: input.context,
    });
    
    return {
      success: true,
      requestId: result.requestId,
      events: result.events,
    };
  },
};
```

### 2. **Plugin Agent** (LangGraph Local)

**Usage** : Ajouter un agent LangGraph local au Data Pod

**Exemple** : Plugin Agent personnalisé pour traitement local

```typescript
// plugins/custom-agent-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { StateGraph, START, END } from '@langchain/langgraph';

export const customAgentPlugin: DataPodPlugin = {
  name: 'custom-agent',
  version: '1.0.0',
  enabled: true,
  
  registerAgent(graph: StateGraph): void {
    // Ajouter un nœud personnalisé
    graph.addNode('customNode', async (state) => {
      // Logique personnalisée
      const result = await processCustomLogic(state);
      return { ...state, customResult: result };
    });
    
    // Ajouter des edges
    graph.addEdge(START, 'customNode');
    graph.addEdge('customNode', END);
  },
};
```

### 3. **Plugin API** (Nouveaux Endpoints)

**Usage** : Ajouter de nouveaux endpoints tRPC au Data Pod

**Exemple** : Plugin API pour fonctionnalité personnalisée

```typescript
// plugins/custom-api-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { router, protectedProcedure } from '@synap/api/trpc';
import { z } from 'zod';

export const customApiPlugin: DataPodPlugin = {
  name: 'custom-api',
  version: '1.0.0',
  enabled: true,
  
  registerRouter(): AnyRouter {
    return router({
      custom: router({
        doSomething: protectedProcedure
          .input(z.object({ param: z.string() }))
          .mutation(async ({ ctx, input }) => {
            // Logique personnalisée
            return { success: true };
          }),
      }),
    });
  },
};
```

---

## 🔧 Interface DataPodPlugin

```typescript
// packages/api/src/plugins/types.ts
export interface DataPodPlugin {
  /** Nom unique du plugin */
  name: string;
  
  /** Version du plugin */
  version: string;
  
  /** Si le plugin est activé */
  enabled: boolean;
  
  /** Pour plugins REST : traiter une pensée */
  processThought?(input: ThoughtInput): Promise<ThoughtResponse>;
  
  /** Pour plugins Agents : enregistrer un agent LangGraph */
  registerAgent?(graph: StateGraph): void;
  
  /** Pour plugins API : enregistrer un router tRPC */
  registerRouter?(): AnyRouter;
  
  /** Pour plugins Tools : enregistrer des outils */
  registerTools?(registry: DynamicToolRegistry): void;
  
  /** Hook d'initialisation */
  onInit?(): Promise<void>;
  
  /** Hook de nettoyage */
  onDestroy?(): Promise<void>;
}
```

---

## 📝 Créer un Plugin

### 1. Structure du Plugin

```
plugins/
└── my-plugin/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts
    │   └── plugin.ts
    └── README.md
```

### 2. Implémentation

```typescript
// plugins/my-plugin/src/plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';

export const myPlugin: DataPodPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  enabled: true,
  
  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    // Votre logique ici
    return {
      success: true,
      requestId: randomUUID(),
      events: [],
    };
  },
  
  async onInit(): Promise<void> {
    // Initialisation (charger config, etc.)
  },
  
  async onDestroy(): Promise<void> {
    // Nettoyage (fermer connexions, etc.)
  },
};
```

### 3. Enregistrer le Plugin

```typescript
// packages/api/src/plugins/index.ts
import { pluginManager } from './plugin-manager.js';
import { myPlugin } from '../../../../plugins/my-plugin/src/plugin.js';

// Enregistrer le plugin
pluginManager.register(myPlugin);
```

---

## 🔐 Authentification Ory

Les plugins peuvent utiliser **Ory Hydra** pour s'authentifier :

### 1. Plugin REST (Client Credentials)

```typescript
// plugins/my-rest-plugin.ts
import { getOryHydraClient } from '@synap/auth';

export const myRestPlugin: DataPodPlugin = {
  name: 'my-rest-plugin',
  version: '1.0.0',
  enabled: true,
  
  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    // Obtenir un token OAuth2
    const hydraClient = getOryHydraClient();
    const tokenResponse = await hydraClient.oauth2Token({
      grantType: 'client_credentials',
      clientId: process.env.MY_PLUGIN_CLIENT_ID!,
      clientSecret: process.env.MY_PLUGIN_CLIENT_SECRET!,
    });
    
    // Appeler le service externe
    const response = await fetch('https://my-service.com/api/process', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenResponse.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    
    return await response.json();
  },
};
```

### 2. Plugin Marketplace (Authorization Code)

```typescript
// plugins/marketplace-plugin.ts
export const marketplacePlugin: DataPodPlugin = {
  name: 'marketplace-plugin',
  version: '1.0.0',
  enabled: true,
  
  registerRouter(): AnyRouter {
    return router({
      marketplace: router({
        // Endpoint pour initier le flow OAuth2
        authorize: publicProcedure
          .query(async ({ ctx }) => {
            const authUrl = await getOAuth2AuthorizationUrl({
              clientId: 'marketplace-plugin',
              redirectUri: 'https://my-plugin.com/callback',
            });
            
            return { authUrl };
          }),
      }),
    });
  },
};
```

---

## 🎯 Exemples Concrets

### Exemple 1 : Plugin Intelligence Hub Synap

```typescript
// plugins/synap-intelligence-hub-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { HubProtocolClient } from '@synap/hub-protocol-client';

export const synapIntelligenceHubPlugin: DataPodPlugin = {
  name: 'synap-intelligence-hub',
  version: '1.0.0',
  enabled: process.env.SYNAP_INTELLIGENCE_HUB_ENABLED === 'true',
  
  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    const hubClient = new HubProtocolClient({
      dataPodUrl: process.env.SYNAP_INTELLIGENCE_HUB_URL!,
      getToken: async () => {
        // Obtenir token OAuth2 via Ory Hydra
        const hydraClient = getOryHydraClient();
        const tokenResponse = await hydraClient.oauth2Token({
          grantType: 'client_credentials',
          clientId: 'synap-intelligence-hub',
          clientSecret: process.env.SYNAP_INTELLIGENCE_HUB_SECRET!,
        });
        return tokenResponse.accessToken;
      },
    });
    
    const result = await hubClient.requestExpertise({
      query: input.content,
      userId: input.userId,
      context: input.context,
    });
    
    return {
      success: true,
      requestId: result.requestId,
      events: result.events,
    };
  },
};
```

### Exemple 2 : Plugin Agent Local Simple

```typescript
// plugins/simple-agent-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { StateGraph, START, END } from '@langchain/langgraph';
import { anthropic } from '@ai-sdk/anthropic';

export const simpleAgentPlugin: DataPodPlugin = {
  name: 'simple-agent',
  version: '1.0.0',
  enabled: true,
  
  registerAgent(graph: StateGraph): void {
    graph.addNode('analyze', async (state) => {
      const result = await anthropic.generateText({
        model: 'claude-3-5-sonnet-20241022',
        prompt: `Analyze this thought: ${state.content}`,
      });
      
      return {
        ...state,
        analysis: result.text,
      };
    });
    
    graph.addEdge(START, 'analyze');
    graph.addEdge('analyze', END);
  },
};
```

### Exemple 3 : Plugin API Personnalisé

```typescript
// plugins/custom-feature-plugin.ts
import { DataPodPlugin } from '@synap/api/plugins';
import { router, protectedProcedure } from '@synap/api/trpc';
import { z } from 'zod';

export const customFeaturePlugin: DataPodPlugin = {
  name: 'custom-feature',
  version: '1.0.0',
  enabled: true,
  
  registerRouter(): AnyRouter {
    return router({
      customFeature: router({
        doSomething: protectedProcedure
          .input(z.object({ param: z.string() }))
          .mutation(async ({ ctx, input }) => {
            const userId = requireUserId(ctx.userId);
            
            // Accéder aux données via les APIs du Data Pod
            const notes = await getNotes(userId);
            
            // Logique personnalisée
            const result = await processCustomLogic(notes, input.param);
            
            return { success: true, result };
          }),
      }),
    });
  },
};
```

---

## 🔧 Plugin Manager

Le **Plugin Manager** gère l'enregistrement et l'exécution des plugins :

```typescript
// packages/api/src/plugins/plugin-manager.ts
class PluginManager {
  private plugins: Map<string, DataPodPlugin> = new Map();
  
  register(plugin: DataPodPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    
    this.plugins.set(plugin.name, plugin);
    
    // Initialiser le plugin
    if (plugin.onInit) {
      await plugin.onInit();
    }
    
    // Enregistrer le router si présent
    if (plugin.registerRouter) {
      const router = plugin.registerRouter();
      dynamicRouterRegistry.register(plugin.name, router);
    }
    
    // Enregistrer l'agent si présent
    if (plugin.registerAgent) {
      const graph = createStateGraph();
      plugin.registerAgent(graph);
      // Ajouter au graphe principal
    }
    
    // Enregistrer les tools si présents
    if (plugin.registerTools) {
      plugin.registerTools(dynamicToolRegistry);
    }
  }
  
  async processThought(input: ThoughtInput): Promise<ThoughtResponse> {
    // Chercher un plugin qui peut traiter la pensée
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled && plugin.processThought) {
        try {
          return await plugin.processThought(input);
        } catch (error) {
          logger.error({ err: error, plugin: plugin.name }, 'Plugin processing failed');
          // Continuer avec le plugin suivant
        }
      }
    }
    
    // Aucun plugin n'a pu traiter, retourner erreur
    throw new Error('No plugin available to process thought');
  }
}
```

---

## 📊 Utilisation dans le Data Pod

### 1. Dans `capture.thought`

```typescript
// packages/api/src/routers/capture.ts
import { pluginManager } from '../plugins/plugin-manager.js';

export const captureRouter = router({
  thought: protectedProcedure
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Option 1: Si un plugin peut traiter
      try {
        const result = await pluginManager.processThought({
          content: input.content,
          userId,
          context: input.context || {},
        });
        
        return {
          success: true,
          requestId: result.requestId,
          mode: 'plugin',
        };
      } catch (error) {
        // Option 2: Traitement local simple (fallback)
        await inngest.send({
          name: 'api/thought.captured',
          data: { content, userId, inputType: 'text' },
        });
        
        return {
          success: true,
          mode: 'local',
        };
      }
    }),
});
```

---

## 🧪 Tests

### 1. Test Unitaire

```typescript
// plugins/my-plugin/src/__tests__/plugin.test.ts
import { describe, it, expect } from 'vitest';
import { myPlugin } from '../plugin.js';

describe('myPlugin', () => {
  it('should process thought', async () => {
    const result = await myPlugin.processThought({
      content: 'Test thought',
      userId: 'user-123',
      context: {},
    });
    
    expect(result.success).toBe(true);
  });
});
```

### 2. Test E2E

```typescript
// tests/e2e/plugins.test.ts
import { describe, it, expect } from 'vitest';
import { pluginManager } from '@synap/api/plugins';

describe('Plugin System E2E', () => {
  it('should process thought via plugin', async () => {
    const result = await pluginManager.processThought({
      content: 'Create a task',
      userId: 'user-123',
      context: {},
    });
    
    expect(result.success).toBe(true);
  });
});
```

---

## 📚 Ressources

- [Router Registry](../packages/api/src/router-registry.ts)
- [Tool Registry](../packages/ai/src/tools/dynamic-registry.ts)
- [Hub Protocol V1.0](../architecture/HUB_PROTOCOL_V1.0.md)
- [Ory Hydra Documentation](https://www.ory.sh/docs/hydra)

---

**Questions ?** Contacte l'équipe d'architecture.

