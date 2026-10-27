import { defineConfig } from 'drizzle-kit';

// Each module owns its tables in modules/<name>/src/db/schema.ts.
// Migrations are generated into one ordered folder so every install applies them in sequence.
export default defineConfig({
  dialect: 'postgresql',
  schema: './modules/*/src/db/schema.ts',
  out: './packages/db/migrations',
  strict: true,
  verbose: true,
});
