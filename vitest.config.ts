import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],  // clears API keys so tests never hit the network
    testTimeout: 30000,  // Phase 3 quality eval; load test uses per-test beforeAll timeout
  },
});
