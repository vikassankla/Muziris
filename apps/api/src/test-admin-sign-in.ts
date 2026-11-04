import { base32Decode, parseTotpKey, totpCode } from '@muziris/identity';

/** The two-factor key the API tests give createApp. Test-only: never a real install's key. */
export const TEST_TWO_FACTOR_KEY = parseTotpKey(Buffer.alloc(32, 1).toString('base64'));

interface TestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** Recovery codes from each admin's enrolment, for sign-ins within the same 30-second step. */
const spareCodes = new Map<string, string[]>();

function cookieFrom(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .map((header) => header.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`__Host-${name}=`) && !pair.endsWith('='));
}

async function expectOk(res: Response, step: string): Promise<Response> {
  if (res.status !== 200) {
    throw new Error(`Admin ${step} answered ${res.status}: ${await res.text()}`);
  }
  return res;
}

/**
 * Signs an admin in as the admin app does (ADR 0026): the password, then enrolment the first
 * time, or a recovery code after (a frozen test clock would replay the same code). Returns
 * the full session's cookie, `name=value`.
 */
export async function signInAdmin(
  app: TestApp,
  input: { email: string; password: string; origin: string; now?: Date; cookie?: string },
): Promise<string> {
  const now = input.now ?? new Date();
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(`/admin/v1/auth${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Origin: input.origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

  const password = await expectOk(
    await post('/sign-in', { email: input.email, password: input.password }),
    'password step',
  );
  const { next } = (await password.json()) as { next: 'code' | 'enrol' };
  const step = cookieFrom(password, 'muziris_admin_two_factor');
  if (!step) throw new Error('The password step set no two-factor cookie');
  const cookie = [step, input.cookie].filter(Boolean).join('; ');

  let done: Response;
  if (next === 'enrol') {
    const enrolment = await expectOk(await post('/two-factor/enrolment', {}, cookie), 'enrolment');
    const { secret } = (await enrolment.json()) as { secret: string };
    done = await expectOk(
      await post(
        '/two-factor/enrolment/confirm',
        { code: totpCode(base32Decode(secret), now) },
        cookie,
      ),
      'enrolment confirmation',
    );
    const { recoveryCodes } = (await done.clone().json()) as { recoveryCodes: string[] };
    spareCodes.set(input.email, recoveryCodes);
  } else {
    const recoveryCode = spareCodes.get(input.email)?.pop();
    if (!recoveryCode) throw new Error(`No recovery code left for ${input.email}`);
    done = await expectOk(await post('/two-factor/verify', { recoveryCode }, cookie), 'code step');
  }
  const session = cookieFrom(done, 'muziris_admin_session');
  if (!session) throw new Error('The code step set no session cookie');
  return session;
}
