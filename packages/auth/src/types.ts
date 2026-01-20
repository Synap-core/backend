/**
 * Type definitions for Ory Stack
 */

export interface Session {
  id: string;
  identity: Identity;
  expires_at?: string;
  authenticated_at?: string;
  issued_at?: string;
}

export interface Identity {
  id: string;
  schema_id: string;
  schema_url: string;
  traits: {
    email: string;
    name?: string;
    [key: string]: unknown;
  };
  created_at?: string;
  updated_at?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
}
