/**
 * React Hook: useYjs
 * 
 * Hook for Yjs CRDT synchronization in a view.
 * 
 * @example
 * ```typescript
 * function TldrawWhiteboard({ roomName }: { roomName: string }) {
 *   const { client } = useSynapClient();
 *   const { ydoc } = useYjs(client?.realtime, roomName);
 *   
 *   if (!ydoc) return <div>Connecting...</div>;
 *   
 *   return <TldrawEditor store={createTLStore({ doc: ydoc })} />;
 * }
 * ```
 */

import { useState, useEffect } from 'react';
import type { RealtimeClient } from '../realtime.js';
import type { YDoc } from '@synap-core/types/realtime';

export interface UseYjsReturn {
  ydoc: YDoc | null;
  isConnected: boolean;
}

export function useYjs(
  client: RealtimeClient | null,
  roomName: string
): UseYjsReturn {
  const [ydoc, setYdoc] = useState<YDoc | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  
  useEffect(() => {
    if (!client) return;
    
    // Connect to Yjs
    const doc = client.connectYjs(roomName);
    setYdoc(doc);
    setIsConnected(true);
    
    // Cleanup
    return () => {
      client.disconnect();
      setYdoc(null);
      setIsConnected(false);
    };
  }, [client, roomName]);
  
  return { ydoc, isConnected };
}
