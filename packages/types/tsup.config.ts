import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'entities/index': 'src/entities/index.ts',
    'documents/index': 'src/documents/index.ts',
    'users/index': 'src/users/index.ts',
    'inbox/index': 'src/inbox/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
