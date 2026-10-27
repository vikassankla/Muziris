import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { isIP } from 'node:net';

/**
 * Works out the caller's IP address for rate limiting and audit.
 *
 * X-Forwarded-For can be forged by anyone, so it is trusted only as far as the operator says:
 * with `trustedProxyHops` set to N, the address N entries from the right is used (the one the
 * outermost trusted proxy saw). With 0, only the TCP peer address is used.
 */
export function resolveClientIp(c: Context, trustedProxyHops: number): string | undefined {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // No socket (for example in-process tests); fall through.
  }
  if (trustedProxyHops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = chain.at(-trustedProxyHops);
    if (candidate && isIP(candidate)) return candidate;
  }
  return peer && isIP(peer) ? peer : undefined;
}
