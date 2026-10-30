import type { Database } from '@muziris/db';
import type { CheckoutDependencies } from '@muziris/orders';
import { findWebsiteByCode } from '@muziris/platform';
import {
  execute,
  getOperationAST,
  GraphQLError,
  NoSchemaIntrospectionCustomRule,
  parse,
  specifiedRules,
  validate,
  type DocumentNode,
} from 'graphql';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError, z } from 'zod';
import { requireSession, trustedOriginGuard, type AuthVariables } from '../auth-routes.js';
import type { Logger } from '../logger.js';
import { limitErrors, MAX_DOCUMENT_LENGTH, measure } from './limits.js';
import { SHA256_HEX, type PersistedQueries } from './persisted.js';
import { createContext, storefrontSchema } from './schema.js';

// The storefront GraphQL endpoint of ADR 0014, mounted at /storefront/v1/graphql. Requests are
// checked in this order: a buyer session, the website, the document (persisted or ad hoc),
// parsing and validation, then the depth and cost limits; only then does anything execute.

export const WEBSITE_HEADER = 'Muziris-Website';

export interface StorefrontOptions {
  /** Registered documents by hash. */
  persistedQueries: PersistedQueries;
  /** Whether query text is accepted. Never in production (ADR 0014). */
  allowAdhocQueries: boolean;
}

export interface StorefrontRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  trustedOrigins: ReadonlySet<string>;
  storefront: StorefrontOptions;
  /** Checkout's tax and other providers; null refuses checkout with TAX_NOT_CONFIGURED. */
  checkout: CheckoutDependencies | null;
}

interface StorefrontEnv {
  Variables: AuthVariables;
}

/** A problem with the request itself; answered with 400 before anything runs. */
class RequestError extends Error {
  readonly code: string;
  readonly extensions: Record<string, unknown>;

  constructor(code: string, message: string, extensions: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.extensions = extensions;
  }
}

const persistedQuerySchema = z.object({
  version: z.literal(1),
  sha256Hash: z.string().regex(SHA256_HEX),
});

const requestSchema = z.object({
  query: z.string().max(MAX_DOCUMENT_LENGTH).optional(),
  variables: z.record(z.string(), z.unknown()).nullable().optional(),
  operationName: z.string().max(200).nullable().optional(),
  extensions: z
    .object({ persistedQuery: persistedQuerySchema.optional() })
    .catchall(z.unknown())
    .nullable()
    .optional(),
});

type GraphqlRequest = z.output<typeof requestSchema>;

/** GET carries the same fields as query string parameters, with JSON in variables and extensions. */
function fromQueryString(c: Context): unknown {
  const json = (name: string): unknown => {
    const value = c.req.query(name);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new RequestError('BAD_REQUEST', `${name} is not valid JSON`);
    }
  };
  const query = c.req.query('query');
  const operationName = c.req.query('operationName');
  return {
    ...(query === undefined ? {} : { query }),
    ...(operationName === undefined ? {} : { operationName }),
    variables: json('variables'),
    extensions: json('extensions'),
  };
}

function readRequest(raw: unknown): GraphqlRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequestError('BAD_REQUEST', 'The request is not a valid GraphQL request');
  }
  return parsed.data;
}

/** The document text a request runs: a registered persisted query, or ad hoc text if allowed. */
function documentText(
  request: GraphqlRequest,
  options: StorefrontOptions,
  method: string,
): { text: string; hash: string | null } {
  const persisted = request.extensions?.persistedQuery;
  if (persisted && request.query !== undefined) {
    throw new RequestError('BAD_REQUEST', 'Send a query or a persisted query hash, not both');
  }
  if (persisted) {
    const text = options.persistedQueries.get(persisted.sha256Hash);
    if (text === undefined) {
      throw new RequestError('PERSISTED_QUERY_NOT_FOUND', 'No persisted query has that hash');
    }
    return { text, hash: persisted.sha256Hash };
  }
  if (request.query === undefined) throw new RequestError('BAD_REQUEST', 'Send a query');
  if (method === 'GET') {
    throw new RequestError('PERSISTED_QUERY_REQUIRED', 'GET runs persisted queries only');
  }
  if (!options.allowAdhocQueries) {
    throw new RequestError('PERSISTED_QUERY_REQUIRED', 'Only persisted queries are accepted');
  }
  return { text: request.query, hash: null };
}

/**
 * Errors the caller may see keep their message and code. GraphQL's own request errors (bad
 * variables, for example) have no original error. Anything else, including a database error,
 * becomes INTERNAL_ERROR with a fixed message; ZodErrors from module validation become
 * BAD_USER_INPUT.
 */
function masked(
  error: GraphQLError,
  log: (err: unknown) => void,
): { message: string; path?: readonly (string | number)[]; extensions: Record<string, unknown> } {
  const original: unknown = error.cause;
  const path = error.path === undefined ? {} : { path: error.path };
  if (original === undefined || original === null) {
    return { message: error.message, ...path, extensions: { code: 'BAD_USER_INPUT' } };
  }
  if (original instanceof GraphQLError && typeof original.extensions['code'] === 'string') {
    return { message: original.message, ...path, extensions: { ...original.extensions } };
  }
  if (original instanceof ZodError) {
    return { message: 'The input is not valid', ...path, extensions: { code: 'BAD_USER_INPUT' } };
  }
  log(original);
  return {
    message: 'Something went wrong on our side',
    ...path,
    extensions: { code: 'INTERNAL_ERROR' },
  };
}

function requestErrors(c: Context, errors: readonly { message: string; extensions: object }[]) {
  return c.json({ errors }, 400 as ContentfulStatusCode);
}

/** The storefront GraphQL endpoint: POST for any operation, GET for persisted queries only. */
export function storefrontRoutes(deps: StorefrontRouteDependencies): Hono<StorefrontEnv> {
  const app = new Hono<StorefrontEnv>();
  const parsedDocuments = new Map<string, DocumentNode>();
  const rules = deps.storefront.allowAdhocQueries
    ? specifiedRules
    : [...specifiedRules, NoSchemaIntrospectionCustomRule];

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('buyer', deps));

  const handle = async (c: Context<StorefrontEnv>) => {
    const requestId = c.get('requestId');
    const user = c.get('user');
    try {
      const code = c.req.header(WEBSITE_HEADER);
      const website = code === undefined ? undefined : await findWebsiteByCode(deps.db, code);
      if (!website) {
        throw new RequestError(
          'WEBSITE_NOT_FOUND',
          `Name the website with a ${WEBSITE_HEADER} header holding its code`,
        );
      }

      let raw: unknown;
      if (c.req.method === 'GET') {
        raw = fromQueryString(c);
      } else {
        if (!(c.req.header('content-type') ?? '').startsWith('application/json')) {
          throw new RequestError('BAD_REQUEST', 'Send the request as application/json');
        }
        raw = await c.req.json().catch(() => {
          throw new RequestError('BAD_REQUEST', 'The body is not valid JSON');
        });
      }
      const request = readRequest(raw);
      const { text, hash } = documentText(request, deps.storefront, c.req.method);

      let document = hash === null ? undefined : parsedDocuments.get(hash);
      if (!document) {
        try {
          document = parse(text, { maxTokens: 5_000 });
        } catch (error) {
          if (error instanceof GraphQLError) {
            return requestErrors(c, [
              { message: error.message, extensions: { code: 'GRAPHQL_PARSE_FAILED' } },
            ]);
          }
          throw error;
        }
        if (hash !== null) parsedDocuments.set(hash, document);
      }

      const invalid = validate(storefrontSchema, document, rules, { maxErrors: 20 });
      if (invalid.length > 0) {
        return requestErrors(
          c,
          invalid.map((e) => ({
            message: e.message,
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          })),
        );
      }
      const operation = getOperationAST(document, request.operationName ?? undefined);
      if (!operation) {
        throw new RequestError('BAD_REQUEST', 'Name one operation of the document to run');
      }
      if (c.req.method === 'GET' && operation.operation !== 'query') {
        throw new RequestError('BAD_REQUEST', 'GET runs queries only');
      }
      const variables = request.variables ?? {};
      const measured = measure(storefrontSchema, document, operation, variables);
      const overLimits = limitErrors(measured);
      if (overLimits.length > 0) {
        return requestErrors(
          c,
          overLimits.map((e) => ({ message: e.message, extensions: e.extensions })),
        );
      }

      const result = await execute({
        schema: storefrontSchema,
        document,
        operationName: request.operationName ?? null,
        variableValues: variables,
        contextValue: createContext({
          db: deps.db,
          now: deps.now(),
          user,
          website,
          checkout: deps.checkout,
        }),
      });
      const errors = (result.errors ?? []).map((e) =>
        masked(e, (err) => {
          deps.logger.error({ requestId, err }, 'storefront.resolver_failed');
        }),
      );
      deps.logger.info(
        {
          requestId,
          userId: user.id,
          persistedQuery: hash,
          depth: measured.depth,
          cost: measured.cost,
          errorCount: errors.length,
        },
        'storefront.graphql',
      );
      // A request that never reached execution (bad variables) has no data: answer 400.
      if (!('data' in result)) return requestErrors(c, errors);
      return c.json(errors.length > 0 ? { data: result.data, errors } : { data: result.data });
    } catch (error) {
      if (error instanceof RequestError) {
        return requestErrors(c, [
          { message: error.message, extensions: { code: error.code, ...error.extensions } },
        ]);
      }
      throw error;
    }
  };

  app.post('/', handle);
  app.get('/', handle);
  return app;
}
