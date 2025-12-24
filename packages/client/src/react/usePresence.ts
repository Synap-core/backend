/**
 * React Hook: usePresence
 * 
 * Hook for real-time presence tracking in a view.
 * 
 * @example
 * ```typescript
 * function WhiteboardView({ viewId }: { viewId: string }) {
 *   const { client } = useSynapClient();
 *   const { users, moveCursor } = usePresence(client?.realtime, viewId);
 *   
 *   return (
 *     <div onMouseMove={(e) => moveCursor(e.clientX, e.clientY)}>
 *       {users.map(user => (
 *         <Cursor key={user.userId} {...user} />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useEffect, useCallback } from 'react';
import type { RealtimeClient } from '../realtime.js';
import type { UserPresence } from '@synap-core/types/realtime';

export interface UsePresenceReturn {
  users: UserPresence[];
  moveCursor: (x: number, y: number) => void;
  setTyping: (isTyping: boolean) => void;
}

export function usePresence(
  client: RealtimeClient | null,
  viewId: string,
  viewType?: string
): UsePresenceReturn {
  const [users, setUsers] = useState<UserPresence[]>([]);
  
  useEffect(() => {
    if (!client) return;
    
    // Connect to presence
    client.connectPresence(viewId, viewType);
    
    // Handle presence initialization
    client.on('presence:init', (data: { users: UserPresence[] }) => {
      setUsers(data.users);
    });
    
    // Handle user joined
    client.on('user-joined', (user: UserPresence) => {
      setUsers(prev => [...prev, user]);
    });
    
    // Handle user left
    client.on('user-left', (data: { userId: string }) => {
      setUsers(prev => prev.filter(u => u.userId !== data.userId));
    });
    
    // Handle cursor updates
    client.on('cursor-update', (data: { userId: string; x: number; y: number }) => {
      setUsers(prev => prev.map(u =>
        u.userId === data.userId
          ? { ...u, cursor: { x: data.x, y: data.y } }
          : u
      ));
    });
    
    // Cleanup
    return () => {
      client.disconnect();
    };
  }, [client, viewId, viewType]);
  
  const moveCursor = useCallback((x: number, y: number) => {
    client?.moveCursor(x, y);
  }, [client]);
  
  const setTyping = useCallback((isTyping: boolean) => {
    client?.setTyping(isTyping);
  }, [client]);
  
  return { users, moveCursor, setTyping };
}
