import type { ApiProblem } from './api.js';

/**
 * Field errors from a validation_failed problem, keyed by the first part of each path
 * ("postalCode", "grants"). The form shows each one under its field.
 */
export function fieldErrors(problem: ApiProblem | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (problem?.code !== 'validation_failed') return errors;
  for (const error of problem.errors) {
    const key = error.path.split('.')[0] ?? '';
    errors[key] ??= error.message;
  }
  return errors;
}

/** Codes like customer_group, admin_role: 2 to 63 lowercase letters, digits or _ (the API's rule). */
export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
export const CODE_HINT =
  'Lowercase letters, digits and underscores, starting with a letter. Cannot be changed later.';
