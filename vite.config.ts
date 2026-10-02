/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build runs from any folder or static host.
  base: './',
  // Some tests play whole matches; give them room on slow machines.
  test: { testTimeout: 20000 },
});
