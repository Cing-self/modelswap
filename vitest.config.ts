import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.{js,ts}'],
    setupFiles: ['tests/setup-isolated-home.ts'],
    server: {
      deps: {
        // Force vitest to process all src files so CJS require() calls get mocked
        inline: [/\/src\//],
      },
    },
  },
});
