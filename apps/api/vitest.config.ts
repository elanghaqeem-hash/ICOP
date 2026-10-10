import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], fileParallelism: false, env: { LOGIN_RATE_LIMIT: '1000' }, testTimeout: 30000, hookTimeout: 60000 } });
