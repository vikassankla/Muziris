/**
 * Creates an admin user with the built-in administrator role. The password is read from the
 * terminal without echo, or from stdin when piped, so it never appears in shell history or the
 * process list.
 *
 *   pnpm --filter @muziris/api admin:create --email asha@acme.example --name "Asha Rao"
 *
 * With --existing, gives an admin who already exists the administrator role instead, for
 * installs whose admins were created before access control.
 *
 *   pnpm --filter @muziris/api admin:create --email asha@acme.example --existing
 */
import { parseArgs } from 'node:util';
import {
  ADMINISTRATOR_ROLE_CODE,
  assignAdminRole,
  ensureBuiltInAdminRoles,
  findAdminRoleByCode,
  SYSTEM_ADMIN_ACCESS,
} from '@muziris/access';
import { createDatabase } from '@muziris/db';
import {
  createUser,
  EmailTakenError,
  findUserByEmail,
  PasswordPolicyError,
} from '@muziris/identity';
import { loadEnv } from '../env.js';

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    existing: { type: 'boolean', default: false },
  },
});
if (!values.email || (!values.name && !values.existing)) {
  process.stderr.write(
    'Usage: admin:create --email <email> --name "<display name>"\n' +
      '       admin:create --email <email> --existing\n',
  );
  process.exit(2);
}

const env = loadEnv();
let password = '';
if (values.existing) {
  // No password needed: the admin already has one.
} else if (process.stdin.isTTY) {
  password = await readHidden('Password: ');
  if ((await readHidden('Repeat password: ')) !== password) {
    process.stderr.write('Passwords do not match\n');
    process.exit(1);
  }
} else {
  password = await readPiped();
}

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  // Seed the role first, so a new admin is never left without one if seeding fails.
  await ensureBuiltInAdminRoles(database.db);
  const administrator = await findAdminRoleByCode(database.db, ADMINISTRATOR_ROLE_CODE);
  if (!administrator) throw new Error('The administrator role is missing after seeding');
  if (values.existing) {
    const user = await findUserByEmail(database.db, 'admin', values.email);
    if (!user) throw new Error('No admin with that email');
    await assignAdminRole(database.db, SYSTEM_ADMIN_ACCESS, user.id, administrator.id);
    process.stdout.write(`Gave ${user.email} (${user.id}) the administrator role\n`);
  } else {
    const user = await createUser(database.db, {
      realm: 'admin',
      email: values.email,
      displayName: values.name ?? '',
      password,
    });
    await assignAdminRole(database.db, SYSTEM_ADMIN_ACCESS, user.id, administrator.id);
    process.stdout.write(`Created admin ${user.email} (${user.id}) with the administrator role\n`);
  }
} catch (error) {
  if (error instanceof PasswordPolicyError) {
    process.stderr.write(
      `Password rejected: ${error.problems.join(', ')}. Use at least 12 characters and avoid common passwords.\n`,
    );
  } else if (error instanceof EmailTakenError) {
    process.stderr.write(
      'An admin with that email already exists. Add --existing to give them the administrator role.\n',
    );
  } else {
    process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
} finally {
  await database.close();
}
