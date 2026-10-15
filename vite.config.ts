import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    lib: {
      entry: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'test-reporter.cjs',
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
    },
  },
});
