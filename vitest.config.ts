import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@': path.resolve(__dirname, 'src') };

/**
 * Two projects, so CI can run them as two jobs in parallel (`--project unit`
 * / `--project ui`) and so the logic tests stop paying for a DOM they never
 * touch.
 *
 * - `unit` — the `*.test.ts` files. Pure logic: Finn/Penny planning, date
 *   math, polyline decoding, the guard tests. None of them render anything,
 *   so they run in the `node` environment with no setup file. Booting jsdom
 *   per worker for these was pure overhead.
 * - `ui`   — the `*.test.tsx` component specs, under jsdom with Testing
 *   Library's matchers (`src/test/setup.ts`).
 *
 * BOTH projects load the React plugin, and the reason is worth keeping:
 * a `.ts` test can still pull `.tsx` modules in transitively. `useNextStop.test.ts`
 * is pure logic and renders nothing, but `useNextStop.ts` imports
 * `DeviceLocationContext.tsx`, so Vite has to be able to transform JSX or the
 * whole file fails at import analysis before a single assertion runs. The
 * file extension describes the TEST, not its import graph. The plugin is
 * cheap and orthogonal to `environment` — it enables the JSX transform, it
 * does not require a DOM.
 *
 * Vitest already runs the files WITHIN a project in parallel across workers;
 * splitting into projects is about splitting the CI jobs, not about
 * unlocking parallelism that wasn't already there.
 *
 * `npm run test` still runs both, which is what you want locally.
 * If a `.test.ts` ever genuinely needs a DOM (renderHook, Testing Library),
 * move it to `.test.tsx` rather than putting jsdom back on the unit project.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
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
