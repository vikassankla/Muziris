/**
 * Prepares an empty install (ADR 0021): creates the organization, the standard product units and
 * buyer roles, and makes Buyer the default buyer role. Running it again changes nothing.
 *
 *   pnpm --filter @muziris/api run setup --organization "Acme Industrial Supply"
 */
import { parseArgs } from 'node:util';
import { createDatabase } from '@muziris/db';
import { loadEnv } from '../env.js';
import { runSetup, SetupError } from '../setup.js';

const { values } = parseArgs({ options: { organization: { type: 'string' } } });

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  const result = await runSetup(database.db, { organizationName: values.organization });
  const { organization } = result;
  process.stdout.write(
    result.organizationCreated
      ? `Created the organization ${organization.name}\n`
      : `The organization is ${organization.name}; left as it is\n`,
  );
  if (values.organization !== undefined && !result.organizationCreated) {
    if (values.organization.trim() !== organization.name) {
      process.stdout.write('One install runs one business, so --organization was ignored\n');
    }
  }
  process.stdout.write(
    result.unitsAdded.length > 0
      ? `Added product units: ${result.unitsAdded.join(', ')}\n`
      : 'The standard product units are already there\n',
  );
  process.stdout.write(
    result.buyerRolesAdded.length > 0
      ? `Added buyer roles: ${result.buyerRolesAdded.join(', ')}\n`
      : 'The standard buyer roles are already there\n',
  );
  if (result.defaultBuyerRoleSet) {
    process.stdout.write('Invited buyers now get the Buyer role when they accept\n');
  }
  process.stdout.write(
    'Next: pnpm --filter @muziris/api admin:create --email <email> --name "<name>", then sign\n' +
      'in to the admin app and create the first website under System > Websites.\n',
  );
} catch (error) {
  process.stderr.write(
    error instanceof SetupError
      ? `${error.message}\n`
      : `Failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
