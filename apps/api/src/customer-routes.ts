import type { AdminPermission } from '@muziris/access';
import {
  addAddress,
  createBuyerUser,
  createCustomer,
  createCustomerGroup,
  createInvitation,
  CustomerError,
  findCustomer,
  linkBuyerUser,
  listAddresses,
  listBuyerUsers,
  listCustomerGroups,
  listCustomers,
  listCustomersQuerySchema,
  listPendingInvitations,
  newAddressSchema,
  newCustomerGroupSchema,
  newCustomerSchema,
  pageQuerySchema,
  revokeInvitation,
  setCustomerGroup,
  setCustomerParent,
  type CustomerErrorCode,
} from '@muziris/customers';
import type { Database } from '@muziris/db';
import { EmailTakenError, PasswordPolicyError } from '@muziris/identity';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface CustomerRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface CustomerEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<CustomerErrorCode, [ContentfulStatusCode, string]> = {
  customer_not_found: [404, 'No such customer'],
  customer_group_not_found: [404, 'No such customer group'],
  customer_group_code_taken: [409, 'A customer group with this code already exists'],
  hierarchy_cycle: [409, 'A customer cannot be moved under itself or its subsidiaries'],
  not_a_buyer: [422, 'There is no buyer account with this email'],
  buyer_user_exists: [409, 'This account is already a buyer user'],
  invitation_not_found: [404, 'No such invitation'],
  invitation_expired: [409, 'The invitation has expired'],
  invitation_closed: [409, 'The invitation was already accepted or revoked'],
  default_address_conflict: [409, 'Another default address was set at the same time; try again'],
};

/** Runs a module call, turning refusals into problem responses with a stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CustomerError) {
      const [status, title] = PROBLEMS[error.code];
      throw new HttpProblem(status, error.code, title);
    }
    if (error instanceof EmailTakenError) {
      throw new HttpProblem(409, 'email_taken', 'An account with this email already exists');
    }
    if (error instanceof PasswordPolicyError) {
      throw new HttpProblem(
        400,
        'password_policy',
        'The password does not meet the password policy',
        error.problems.join(', '),
      );
    }
    throw error;
  }
}

const idParam = z.uuid();

/** Query strings carry text only; these turn them into numbers and booleans. */
const limitText = z
  .string()
  .regex(/^\d{1,4}$/, 'Use a whole number')
  .transform(Number)
  .optional();
const booleanText = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Drops keys whose value is undefined, for exactOptionalPropertyTypes. */
function defined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

const pageQuery = z
  .object({ after: z.string().max(100).optional(), limit: limitText })
  .transform((q) => pageQuerySchema.parse(defined(q)));

const listCustomersQuery = z
  .object({
    parentId: z.string().max(100).optional(),
    topLevel: booleanText,
    groupId: z.string().max(100).optional(),
    after: z.string().max(100).optional(),
    limit: limitText,
  })
  .transform((q) => listCustomersQuerySchema.parse(defined(q)));

const setParentBody = z.object({ parentId: z.uuid().nullable() });
const setGroupBody = z.object({ groupId: z.uuid().nullable() });

const newBuyerUserBody = z.object({
  email: z.string().max(254),
  displayName: z.string().max(200),
  /** Omit to create an account that sets its password later. */
  password: z.string().min(1).max(1024).optional(),
});

const linkBuyerUserBody = z.object({ email: z.string().max(254) });

const newInvitationBody = z.object({
  email: z.string().max(254),
  displayName: z.string().max(200),
  /** How long the invitation stays open; the module's default (seven days) when omitted. */
  expiresInHours: z
    .int()
    .min(1)
    .max(30 * 24)
    .optional(),
});

/**
 * Customers, their hierarchy, customer groups, buyer users, invitations and addresses,
 * mounted under /admin/v1/customers.
 */
export function customerRoutes(deps: CustomerRouteDependencies): Hono<CustomerEnv> {
  const app = new Hono<CustomerEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));
  /** Who did it, for audit log lines. Never bodies, emails or tokens. */
  const actor = (c: Context<CustomerEnv>) => ({
    requestId: c.get('requestId'),
    userId: c.get('user').id,
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  /** Loads a customer for a nested route, or answers 404. */
  async function existingCustomer(customerId: string) {
    const customer = await findCustomer(deps.db, customerId);
    if (!customer) throw new HttpProblem(404, 'customer_not_found', 'No such customer');
    return customer;
  }

  // Literal paths come before /:customerId, so they are never read as a customer id.

  app.get('/groups', need('customer.view'), async (c) =>
    c.json(await listCustomerGroups(deps.db, pageQuery.parse(c.req.query()))),
  );

  app.post('/groups', need('customer.manage'), async (c) => {
    const input = newCustomerGroupSchema.parse(await body(c));
    const customerGroup = await translated(() => createCustomerGroup(deps.db, input));
    deps.logger.info(
      { ...actor(c), customerGroupId: customerGroup.id },
      'customers.customer_group_created',
    );
    return c.json({ customerGroup }, 201);
  });

  app.post('/invitations/:invitationId/revoke', need('customer.manage'), async (c) => {
    const invitationId = idParam.parse(c.req.param('invitationId'));
    const invitation = await translated(() => revokeInvitation(deps.db, invitationId, deps.now()));
    deps.logger.info({ ...actor(c), invitationId }, 'customers.invitation_revoked');
    return c.json({ invitation });
  });

  app.get('/', need('customer.view'), async (c) =>
    c.json(await listCustomers(deps.db, listCustomersQuery.parse(c.req.query()))),
  );

  app.post('/', need('customer.manage'), async (c) => {
    const input = newCustomerSchema.parse(await body(c));
    const customer = await translated(() => createCustomer(deps.db, input));
    deps.logger.info({ ...actor(c), customerId: customer.id }, 'customers.customer_created');
    return c.json({ customer }, 201);
  });

  app.get('/:customerId', need('customer.view'), async (c) => {
    const customer = await existingCustomer(idParam.parse(c.req.param('customerId')));
    return c.json({ customer });
  });

  /** Direct subsidiaries, a page at a time. */
  app.get('/:customerId/subsidiaries', need('customer.view'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const page = pageQuery.parse(c.req.query());
    await existingCustomer(customerId);
    return c.json(await listCustomers(deps.db, { ...page, parentId: customerId }));
  });

  app.put('/:customerId/parent', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const { parentId } = setParentBody.parse(await body(c));
    const customer = await translated(() => setCustomerParent(deps.db, customerId, parentId));
    deps.logger.info({ ...actor(c), customerId, parentId }, 'customers.customer_moved');
    return c.json({ customer });
  });

  app.put('/:customerId/group', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const { groupId } = setGroupBody.parse(await body(c));
    const customer = await translated(() => setCustomerGroup(deps.db, customerId, groupId));
    deps.logger.info(
      { ...actor(c), customerId, customerGroupId: groupId },
      'customers.customer_group_set',
    );
    return c.json({ customer });
  });

  app.get('/:customerId/buyer-users', need('customer.view'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const page = pageQuery.parse(c.req.query());
    await existingCustomer(customerId);
    return c.json(await listBuyerUsers(deps.db, customerId, page));
  });

  /** Creates a buyer account and makes it a buyer user of the customer. */
  app.post('/:customerId/buyer-users', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const input = newBuyerUserBody.parse(await body(c));
    const buyerUser = await translated(() =>
      createBuyerUser(deps.db, {
        customerId,
        email: input.email,
        displayName: input.displayName,
        ...(input.password === undefined ? {} : { password: input.password }),
      }),
    );
    deps.logger.info(
      { ...actor(c), customerId, buyerUserId: buyerUser.userId },
      'customers.buyer_user_created',
    );
    return c.json({ buyerUser }, 201);
  });

  /** Makes an existing buyer account a buyer user of the customer. */
  app.post('/:customerId/buyer-users/link', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const { email } = linkBuyerUserBody.parse(await body(c));
    const buyerUser = await translated(() => linkBuyerUser(deps.db, customerId, email));
    deps.logger.info(
      { ...actor(c), customerId, buyerUserId: buyerUser.userId },
      'customers.buyer_user_linked',
    );
    return c.json({ buyerUser }, 201);
  });

  /** Invitations that can still be accepted, oldest first. */
  app.get('/:customerId/invitations', need('customer.view'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const page = pageQuery.parse(c.req.query());
    await existingCustomer(customerId);
    return c.json(await listPendingInvitations(deps.db, customerId, deps.now(), page));
  });

  /**
   * Invites a person to become a buyer user. The response carries the token once, for the
   * accept link, because invitation emails are not built yet (week 4). It is never logged.
   */
  app.post('/:customerId/invitations', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const input = newInvitationBody.parse(await body(c));
    const { invitation, token } = await translated(() =>
      createInvitation(deps.db, {
        customerId,
        email: input.email,
        displayName: input.displayName,
        invitedByUserId: c.get('user').id,
        now: deps.now(),
        ...(input.expiresInHours === undefined ? {} : { ttlMs: input.expiresInHours * 3_600_000 }),
      }),
    );
    deps.logger.info(
      { ...actor(c), customerId, invitationId: invitation.id },
      'customers.invitation_created',
    );
    return c.json({ invitation, token }, 201);
  });

  app.get('/:customerId/addresses', need('customer.view'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    const page = pageQuery.parse(c.req.query());
    await existingCustomer(customerId);
    return c.json(await listAddresses(deps.db, customerId, page));
  });

  app.post('/:customerId/addresses', need('customer.manage'), async (c) => {
    const customerId = idParam.parse(c.req.param('customerId'));
    // The customer always comes from the path, never from the body.
    const fields = z.record(z.string(), z.unknown()).parse(await body(c));
    const input = newAddressSchema.parse({ ...fields, customerId });
    const address = await translated(() => addAddress(deps.db, input));
    deps.logger.info({ ...actor(c), customerId, addressId: address.id }, 'customers.address_added');
    return c.json({ address }, 201);
  });

  return app;
}
