/**
 * Pure View Types
 * 
 * Decoupled from Drizzle schema to allow usage in frontend bundles
 * without pulling in database dependencies.
 */

export interface View {
  id: string;
  workspaceId: string | null;
  userId: string;
  type: string;
  category: string;
  name: string;
  description: string | null;
  
  // Content references
  documentId: string | null;
  
  // Real-time
  yjsRoomId: string | null;
  thumbnailUrl: string | null;
  
  // Config
  metadata: Record<string, any>;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export type NewView = Omit<View, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
