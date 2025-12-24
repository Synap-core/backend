import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/entities/index.ts',
    'src/documents/index.ts',
    'src/users/index.ts',
    'src/inbox/index.ts',
    'src/workspaces/index.ts',
    'src/views/index.ts',
    'src/preferences/index.ts',
    'src/realtime/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@synap/database', 'yjs'],
});
