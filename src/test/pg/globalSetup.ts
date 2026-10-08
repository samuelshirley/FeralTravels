import type { TestProject } from 'vitest/node';
import { schemaDdl } from './ddl';

declare module 'vitest' {
  export interface ProvidedContext {
    pgSchemaDdl: string[];
  }
}

/**
 * Pushes the schema ONCE per run and hands every test file the statements, so
 * each file boots a bare PGlite and replays them instead of re-introspecting.
 */
export default async function setup(project: TestProject) {
  project.provide('pgSchemaDdl', await schemaDdl());
}
