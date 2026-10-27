# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Report a vulnerability" under the Security tab). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge
reports within 3 working days and to agree a disclosure date with you once a fix is ready.

## Supported versions

Muziris is pre-release. Until version 1.0, only the latest commit on `main` receives security
fixes.

## How the project handles security

- No secrets in the repository. Configuration comes from the environment and is validated at
  startup; error messages name a bad variable without printing its value.
- Every merge runs a dependency audit, static analysis and secret scanning.
- Card data never touches Muziris servers: payments use the gateways' hosted fields.
- Error responses never include stack traces or internal details, and logs redact passwords,
  tokens, cookies and authorization headers.
- Changes to payments, tax, access control and secrets need a second reviewer.
