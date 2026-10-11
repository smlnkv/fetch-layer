import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/layers/index.ts',
    'src/layers/auth/index.ts',
    'src/layers/idempotency/index.ts',
    'src/layers/retry/index.ts',
    'src/shared/storage.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  sourcemap: false,
  treeshake: true,
  minify: true,
});
