import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  listEmails,
  NotificationError,
  retryEmail,
  type NotificationErrorCode,
} from '@muziris/notifications';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

// The email outbox under /admin/v1/notifications (ADR 0020): what was sent, what is waiting and
// what gave up, with "send again". Bodies are never returned: an invitation's held its token.

export interface NotificationRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface NotificationEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<NotificationErrorCode, [ContentfulStatusCode, string]> = {
  notification_not_found: [404, 'No such email'],
  notification_not_failed: [409, 'Only a failed email can be sent again'],
  notification_body_discarded: [
    409,
    'This email held a secret and was emptied; send the invitation again instead',
  ],
};

const listQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed']).optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function notificationRoutes(deps: NotificationRouteDependencies): Hono<NotificationEnv> {
  const app = new Hono<NotificationEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/', need('notification.view'), async (c) => {
    const q = listQuery.parse(c.req.query());
    return c.json(
      await listEmails(deps.db, {
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.after === undefined ? {} : { after: q.after }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      }),
    );
  });

  app.post('/:emailId/retry', need('notification.manage'), async (c) => {
    const emailId = c.req.param('emailId');
    try {
      const email = await retryEmail(deps.db, emailId, deps.now());
      deps.logger.info(
        { requestId: c.get('requestId'), userId: c.get('user').id, emailId: email.id },
        'notifications.retried',
      );
      return c.json({ email });
    } catch (error) {
      if (error instanceof NotificationError) {
        const [status, title] = PROBLEMS[error.code];
        throw new HttpProblem(status, error.code, title);
      }
      throw error;
    }
  });

  return app;
}
