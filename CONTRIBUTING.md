# Contributing to Muziris

Thank you for helping. This guide covers what every change needs before it can merge.

## Sign your commits (Developer Certificate of Origin)

Every commit must carry a `Signed-off-by` line, which certifies that you wrote the change or have
the right to submit it under the Apache License 2.0 (see https://developercertificate.org).
Add it with `git commit -s`. Pull requests with unsigned commits cannot be merged.

Never copy code from OroCommerce or other copyleft projects, even small snippets. They may be
read to understand behaviour, but every line here must be written fresh.

## Definition of done

A change merges only when:

- its acceptance criteria were written down before the code (in the issue or pull request)
- unit and integration tests pass, and anything touching pricing, tax, order totals or access
  control also passes its known-answer tests
- `pnpm check` passes: formatting, lint (including module boundaries), typecheck and tests
- database changes come as a generated migration that applies cleanly to existing data
- any API change is documented in the changelog
- a maintainer has reviewed and approved it
- documentation for the feature is updated

## Module boundaries

Code is organised in modules under `modules/`. A module owns its tables; other modules never
query them directly and import only from the module's `src/index.ts`. The linter enforces the
import rule. If you need data from another module, add a function to its public interface.

## Tests must never be weakened to pass

If a test fails, fix the code. Changing an existing test needs a reason in the pull request and
explicit reviewer sign-off.

## Commit and branch style

- One logical change per pull request, branched from `main`.
- Commit messages: a short imperative summary line, a blank line, then why the change is needed.

## Code of conduct

Everyone taking part follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
