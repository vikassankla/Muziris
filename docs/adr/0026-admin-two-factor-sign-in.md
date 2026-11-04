# 0026: Two-factor sign-in for admins

- Status: accepted
- Date: 2026-11-03

## Context

Admin accounts change prices, tax rates, permissions and payment settings. ADR 0005 signs them
in with a password, server-side sessions and brute-force limits, and says admin multi-factor
authentication must come before the first production install. OWASP ASVS 5.0 level 2, which
ADR 0005 targets, expects multi-factor authentication for privileged accounts. The pilot
businesses use phones, not hardware keys, and the install has no SMS or push provider
(ADR 0002 keeps infrastructure to PostgreSQL).

## Decision

Every admin signs in with a password and a **time-based one-time code (TOTP, RFC 6238)** from an
authenticator app, with **recovery codes** for a lost phone. Passkeys (WebAuthn) as a second
kind of factor are later work. Buyers are not affected.

### Codes

- **Format:** SHA-1, 6 digits and a 30-second step, which every authenticator app reads. The
  code from one step either side is also accepted, for clock drift.
- **No library.** We implement it with `node:crypto` (HMAC per RFC 4226 and 6238). The RFC's own
  test vectors become known-answer tests.
- **No replays.** A code is accepted once: the last accepted time step is stored, and a code
  for that step or an earlier one is refused.
- **Encrypted secrets.** The 160-bit secret is encrypted at rest with AES-256-GCM. The key is
  `ADMIN_TOTP_KEY`, 32 bytes in base64, from the environment and the secret store only. The API
  refuses to start without it in production. Rotating the key re-encrypts the secrets with
  a CLI command.
- **Recovery codes:** 10 per admin, each 10 random characters, stored as SHA-256 hashes and used
  once. Generating new ones replaces the old.

### Sign-in

1. **Password.** A correct password gives a **pending session**. It lasts 5 minutes, grants no
   permissions, and allows only the code step. It uses the same `__Host-` cookie rules as a
   session.
2. **Code.** A correct code (or a recovery code) turns it into a full session.
3. **Failures.** Wrong codes count toward the account lock and rate limits of ADR 0005, and
   answer with the same 401 as a wrong password.
4. **Enrolment.** An admin without a second factor is sent to enrolment after the password.
   The steps:
   - show the secret as a QR code and as text;
   - ask for one code to confirm;
   - show the recovery codes once.

   No admin screen opens until enrolment is done. Existing admins enrol at their next sign-in
   after the release.

### Changes and resets

- **Signed-in changes.** Re-enrolling, generating new recovery codes, and turning the factor
  off all need the password and a current code. Each ends the admin's other sessions.
- **Resets.** An admin holding `admin_user.manage` can reset another admin's second factor, so
  that admin enrols again at their next sign-in. The reset is logged with both user ids.
- **The last administrator.** For a sole administrator, a CLI command does the same from the
  server: `admin:reset-2fa --email ...` in the API package.
- **Logging.** Enrolment, use of a recovery code, reset and failures are logged, without codes or
  secrets.

### As built

- **In identity.** `totp.ts` holds HOTP and TOTP, base32, the `otpauth://` link, AES-256-GCM
  for the secrets (the user id is the associated data, so a secret copied to another row does
  not decrypt) and the recovery codes. `two-factor.ts` holds the steps. The RFC 4226 and 6238
  vectors are its known-answer tests. Migration `0019` adds `identity_two_factor`,
  `identity_recovery_code` and a `stage` on `identity_session`.
- **The pending session** is a session row with stage `two_factor`, lasting 5 minutes, on a
  cookie of its own, `__Host-muziris_admin_two_factor` (Strict). `validateSession` never
  accepts it. The code step ends it and opens a full session with a **new token**, so the
  pending token is never the session.
- **The account lock.** A right password alone no longer clears the failure count; a right
  code does. So an attacker who has the password cannot reset the lock by signing in again.
- **Limits.** Codes share the per-IP sign-in limit, and add 10 per admin per 10 minutes. A
  wrong code answers 401 `invalid_code` with one message for wrong and locked, like
  `invalid_credentials`. An ended step answers 401 `two_factor_expired`.
- **Recovery codes** are 10 characters from an alphabet without look-alikes, shown as two
  groups of five; case, spaces and dashes do not matter. They are stored as **Argon2id**
  hashes, with the password parameters and one random salt per set, not as the SHA-256 named
  above: ten such characters are about 50 bits, few enough that a copied table of SHA-256
  hashes could be searched in about a day. A set shares its salt, so checking a code is one
  hash.
- **Signed-in changes** are on the admin's own **Security** page (profile menu): new recovery
  codes, and moving to a new phone. The move keeps the current secret working until a code
  from the new one is entered, then renews the recovery codes. Both need the password and a
  current code and end the admin's other sessions. There is **no "turn off"**: every admin must
  have a second factor, so turning it off would only mean enrolling again.
- **Resets.** `POST /admin/v1/access/admin-users/:id/two-factor/reset` needs
  `admin_user.manage` and refuses the admin's own id. It has no screen yet; the admin users
  screen is still to come. `admin:reset-2fa --email` does the same from the server.
- **Key rotation** is `admin:rotate-2fa-key`, with the old key in `ADMIN_TOTP_KEY_PREVIOUS` and the
  new one in `ADMIN_TOTP_KEY`, in one transaction.
- **Without `ADMIN_TOTP_KEY`** outside production the API starts and warns, and admin sign-in
  answers 503 `two_factor_not_configured`. Docker Compose passes the key from `.env`; the
  end-to-end suite makes a new one for every run, and its setup enrols the administrator by
  reading the setup key off the page.
- **The QR code** is drawn by `uqr` 0.1.3 (MIT, no dependencies) as SVG in the admin app.
  Secrets and recovery codes are held in component state only.
- **Log events:** `auth.password_accepted`, `auth.two_factor_enrolled`, `auth.recovery_code_used`
  (with the count left), `auth.recovery_codes_replaced`, `auth.two_factor_replaced`,
  `auth.two_factor_reset` (both user ids), `auth.two_factor_failed` (the reason) and
  `auth.two_factor_rate_limited`. None of them logs a code or a secret.

## Consequences

- A stolen admin password alone no longer signs in. Phishing in real time is still possible
  until passkeys arrive.
- One migration in identity: the factor secret, last step and recovery code hashes per user.
- A new secret, `ADMIN_TOTP_KEY`, in the install guide and `.env.example`. Losing it locks out
  every admin's second factor, so it must be backed up with the database credentials.
- The admin app gains the code step, enrolment and the security section on the admin's own
  profile.
- The Docker test stack generates a test key, and end-to-end tests (ADR 0024) read codes with
  the same TOTP function.
- **Second reviewer.** This is authentication and handles a secret, so its pull requests need a
  second human reviewer under CLAUDE.md rule 4.
- Not in this decision: passkeys, SSO (OIDC, SAML), two-factor for buyers, and remembering a
  device.
