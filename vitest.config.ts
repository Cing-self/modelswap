import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.{js,ts}'],
    server: {
      deps: {
        // Force vitest to process all src files so CJS require() calls get mocked
        inline: [/\/src\//],
      },
    },
  },
});
