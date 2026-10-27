import postgres from 'postgres';

const SUFFIX_PATTERN = /^[a-z0-9_]{1,30}$/;

/**
 * Returns a connection string for a database dedicated to one test file, creating it on first
 * use. Test suites run in parallel and empty their tables between tests, so sharing one database
 * would let them wipe each other's data mid-test.
 *
 * Given postgres://.../muziris_test and suffix "identity", the result points at
 * muziris_test_identity on the same server.
 */
export async function prepareTestDatabase(baseUrl: string, suffix: string): Promise<string> {
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new TypeError('Test database suffix must be 1 to 30 lowercase letters, digits or _');
  }
  const url = new URL(baseUrl);
  const baseName = decodeURIComponent(url.pathname.slice(1));
  const name = `${baseName}_${suffix}`;
  if (!/^[A-Za-z0-9_]{1,63}$/.test(name)) {
    throw new TypeError('Test database name must be at most 63 letters, digits or _');
  }

  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${name}`;
    if (existing.length === 0) {
      try {
        // Identifiers cannot be parameters; the name was checked against a strict pattern above.
        await admin.unsafe(`create database "${name}"`);
      } catch (error) {
        // Another suite created it at the same moment.
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}
