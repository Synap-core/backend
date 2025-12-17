/**
 * useThreads Hook
 * 
 * Fetches chat threads from Data Pod via tRPC
 * 
 * DISABLED - chat router not implemented in @synap/api yet
 */

// import { useSynap } from './provider.js';

/**
 * Fetch user's chat threads
 */
export function useThreads(_limit: number = 20): any {
  throw new Error('Chat router not yet implemented in API');
  // const { api } = useSynap();
  // return api.chat.getThreads.useQuery({ limit });
}

/**
 * Fetch single thread with messages
 */
export function useThread(_threadId: string, _limit: number = 100): any {
  throw new Error('Chat router not yet implemented in API');
  // const { api } = useSynap();
  // return api.chat.getThread.useQuery({ threadId, limit }, {
  //   enabled: !!threadId,
  // });
}

/**
 * Get branches from a message
 */
export function useBranches(_parentId: string): any {
  throw new Error('Chat router not yet implemented in API');
  // const { api } = useSynap();
  // return api.chat.getBranches.useQuery({ parentId }, {
  //   enabled: !!parentId,
  // });
}

/**
 * Send chat message mutation
 */
export function useSendMessage(): any {
  throw new Error('Chat router not yet implemented in API');
  // const { api } = useSynap();
  // const utils = api.useUtils();
  //   
  // return api.chat.sendMessage.useMutation({
  //   onSuccess: (_data: unknown, variables: { threadId?: string }) => {
  //     if (variables.threadId) {
  //       utils.chat.getThread.invalidate({ threadId: variables.threadId });
  //     }
  //     utils.chat.getThreads.invalidate();
  //   },
  // });
}

/**
 * Create branch mutation
 */
export function useCreateBranch(): any {
  throw new Error('Chat router not yet implemented in API');
  // const { api } = useSynap();
  // return api.chat.createBranch.useMutation();
}
