/**
 * Creates an admin user. The password is read from the terminal without echo, or from stdin
 * when piped, so it never appears in shell history or the process list.
 *
 *   pnpm --filter @muziris/api admin:create --email asha@acme.example --name "Asha Rao"
 */
import { parseArgs } from 'node:util';
import { createDatabase } from '@muziris/db';
import { createUser, EmailTakenError, PasswordPolicyError } from '@muziris/identity';
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
  options: { email: { type: 'string' }, name: { type: 'string' } },
});
if (!values.email || !values.name) {
  process.stderr.write('Usage: admin:create --email <email> --name "<display name>"\n');
  process.exit(2);
}

const env = loadEnv();
let password: string;
if (process.stdin.isTTY) {
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
  const user = await createUser(database.db, {
    realm: 'admin',
    email: values.email,
    displayName: values.name,
    password,
  });
  process.stdout.write(`Created admin ${user.email} (${user.id})\n`);
} catch (error) {
  if (error instanceof PasswordPolicyError) {
    process.stderr.write(
      `Password rejected: ${error.problems.join(', ')}. Use at least 12 characters and avoid common passwords.\n`,
    );
  } else if (error instanceof EmailTakenError) {
    process.stderr.write('An admin with that email already exists\n');
  } else {
    process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
} finally {
  await database.close();
}
