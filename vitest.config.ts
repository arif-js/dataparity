import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests need live databases; they skip themselves when the
    // databases are not reachable.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
