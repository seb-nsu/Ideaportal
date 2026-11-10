import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Frontend tests (docs/enterprise/qualitaet-und-lieferkette.md): jsdom and Testing Library.
// Tests live in web/test/ so that the text and security checks of web/src stay focused on the app.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
  },
});
