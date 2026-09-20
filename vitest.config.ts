import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Force import.meta.env.DEV to false so the DEV-only self-check blocks (console.assert samples)
  // scattered through src/ don't run during unit tests.
  define: { 'import.meta.env.DEV': 'false' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
