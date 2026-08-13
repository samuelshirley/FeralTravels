import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@': path.resolve(__dirname, 'src') };

/**
 * Two projects, so CI can run them as two jobs in parallel (`--project unit`
 * / `--project ui`) and so the logic tests stop paying for a DOM they never
 * touch.
 *
 * - `unit` — the 43 `*.test.ts` files. Pure logic: Finn/Penny planning, date
 *   math, polyline decoding, the guard tests. None of them reference
 *   `document` or `window`, so they run in the `node` environment with no
 *   setup file. Booting jsdom per worker for these was pure overhead.
 * - `ui`   — the `*.test.tsx` component specs, under jsdom with Testing
 *   Library's matchers (`src/test/setup.ts`) and the React plugin for JSX.
 *
 * Vitest already runs the files WITHIN a project in parallel across workers;
 * splitting into projects is about splitting the CI jobs, not about
 * unlocking parallelism that wasn't there.
 *
 * `npm run test` still runs both, which is what you want locally.
 * If a `.test.ts` ever does need a DOM, it will fail loudly here rather than
 * silently — rename it to `.test.tsx` (or move the DOM part into a component
 * spec) rather than putting jsdom back on the unit project.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});
