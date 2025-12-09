/**
 * useEntities Hook
 * 
 * Fetches entities from Data Pod via tRPC
 */

import { useSynap } from './provider.js';

export interface UseEntitiesOptions {
  type?: 'task' | 'contact' | 'meeting' | 'idea' | 'note' | 'project';
  limit?: number;
  offset?: number;
}

/**
 * Fetch user's entities
 */
export function useEntities(options: UseEntitiesOptions = {}): any {
  const { api } = useSynap();
  return api.entities.list.useQuery({
    type: options.type,
    limit: options.limit || 50,
  });
}

/**
 * Fetch single entity by ID
 */
export function useEntity(id: string): any {
  const { api } = useSynap();
  return api.entities.get.useQuery({ id }, {
    enabled: !!id,
  });
}

/**
 * Search entities by text
 */
export function useEntitySearch(query: string, options: Omit<UseEntitiesOptions, 'offset'> = {}): any {
  const { api } = useSynap();
  return api.entities.search.useQuery({
    query,
    type: options.type,
    limit: options.limit || 20,
  }, {
    enabled: query.length > 0,
  });
}

/**
 * Create entity mutation
 */
export function useCreateEntity(): any {
  const { api } = useSynap();
  const utils = api.useUtils();
  
  return api.entities.create.useMutation({
    onSuccess: () => {
      utils.entities.list.invalidate();
    },
  });
}

/**
 * Update entity mutation
 */
export function useUpdateEntity(): any {
  const { api } = useSynap();
  const utils = api.useUtils();
  
  return api.entities.update.useMutation({
    onSuccess: () => {
      utils.entities.list.invalidate();
    },
  });
}

/**
 * Delete entity mutation
 */
export function useDeleteEntity(): any {
  const { api } = useSynap();
  const utils = api.useUtils();
  
  return api.entities.delete.useMutation({
    onSuccess: () => {
      utils.entities.list.invalidate();
    },
  });
}
