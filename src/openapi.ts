export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Supermarket API',
      version: '0.1.0',
      description:
        'Sampled retail price estimates for ten Israeli chains. This service has no HTTP credential. Search, refresh, and status are process-wide routes.',
    },
    paths: {
      '/health/live': { get: { operationId: 'live', responses: { '200': { description: 'Process is up' } } } },
      '/health/ready': { get: { operationId: 'ready', responses: { '200': { description: 'Database accepts a check' }, '503': { description: 'Database unavailable' } } } },
      '/v1/search': { get: { operationId: 'search', parameters: searchParameters, responses: okArray } },
      '/v1/search/batch': { post: { operationId: 'searchBatch', responses: { '200': { description: 'Results in request order' } } } },
      '/v1/refreshes': {
        post: {
          operationId: 'createRefresh',
          responses: {
            '202': { description: 'Run admitted. dispatchState is ACKNOWLEDGED or UNCERTAIN' },
            '409': { description: 'A requested chain already has an active run' },
            '503': { description: 'Dispatch is not configured or GitHub rejected it' },
          },
        },
      },
      '/v1/refreshes/{runId}': { get: { operationId: 'getRefresh', responses: { '200': { description: 'Run status' }, '404': { description: 'Unknown run' } } } },
      '/v1/chains': { get: { operationId: 'listChains', responses: { '200': { description: 'Chain publication status' } } } },
      '/v1/auth/signup': {
        post: {
          operationId: 'signup',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'User created (no API key issued at signup)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user', 'token', 'refreshToken'],
                    properties: {
                      user: { $ref: '#/components/schemas/User' },
                      token: { type: 'string' },
                      refreshToken: { type: 'string' },
                    },
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/Error' },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/auth/login': {
        post: {
          operationId: 'login',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Access token + refresh token',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['token', 'refreshToken', 'user'],
                    properties: {
                      token: { type: 'string' },
                      refreshToken: { type: 'string' },
                      user: { $ref: '#/components/schemas/User' },
                    },
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/Error' },
            '401': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/auth/refresh': {
        post: {
          operationId: 'refreshToken',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refresh_token'],
                  properties: {
                    refresh_token: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'New access token + new refresh token',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['token', 'refreshToken', 'user'],
                    properties: {
                      token: { type: 'string' },
                      refreshToken: { type: 'string' },
                      user: { $ref: '#/components/schemas/User' },
                    },
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/Error' },
            '401': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/auth/keys': {
        post: {
          operationId: 'createApiKey',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['key_type'],
                  properties: {
                    key_type: { type: 'string', enum: ['live', 'test'] },
                    expires_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'API key created (plaintext shown once)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApiKeyResponse' },
                },
              },
            },
            '400': { $ref: '#/components/responses/Error' },
            '401': { $ref: '#/components/responses/Error' },
          },
        },
        get: {
          operationId: 'listApiKeys',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'List of API keys (metadata only)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['keys', 'total', 'limit', 'offset'],
                    properties: {
                      keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyMetadata' } },
                      total: { type: 'integer' },
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/auth/keys/{id}/revoke': {
        post: {
          operationId: 'revokeApiKey',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '204': { description: 'API key revoked' },
            '401': { $ref: '#/components/responses/Error' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/auth/keys/{id}/rotate': {
        post: {
          operationId: 'rotateApiKey',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'New API key (plaintext shown once)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApiKeyResponse' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Error' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/billing/tiers': {
        get: {
          operationId: 'listBillingTiers',
          responses: {
            '200': {
              description: 'Available subscription tiers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['tiers'],
                    properties: {
                      tiers: { type: 'array', items: { $ref: '#/components/schemas/Tier' } },
                    },
                  },
                },
              },
            },
            '503': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/v1/billing/credits/topup': {
        post: {
          operationId: 'topUpCredits',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['pack_id'],
                  properties: {
                    pack_id: {
                      type: 'string',
                      enum: ['pack_10usd', 'pack_50usd', 'pack_100usd'],
                    },
                    amount_usd: { type: 'number' },
                    credits: { type: 'integer' },
                    reference_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Credits added to the developer balance',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TopUpResponse' },
                },
              },
            },
            '400': { $ref: '#/components/responses/Error' },
            '401': { $ref: '#/components/responses/Error' },
            '404': { $ref: '#/components/responses/Error' },
            '409': { $ref: '#/components/responses/Error' },
            '503': { $ref: '#/components/responses/Error' },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'requestId'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'array', items: { type: 'object' } },
              },
            },
            requestId: { type: 'string' },
          },
        },
        User: {
          type: 'object',
          required: ['id', 'email', 'tier'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            tier: { type: 'string', enum: ['free', 'paid_starter', 'paid_pro'] },
          },
        },
        ApiKeyMetadata: {
          type: 'object',
          required: ['id', 'key_id', 'key_type', 'key_last4', 'is_active', 'created_at'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            key_id: { type: 'string' },
            key_type: { type: 'string', enum: ['live', 'test'] },
            key_last4: { type: 'string' },
            is_active: { type: 'boolean' },
            revoked_at: { type: 'string', format: 'date-time', nullable: true },
            expires_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        ApiKeyResponse: {
          allOf: [
            { $ref: '#/components/schemas/ApiKeyMetadata' },
            {
              type: 'object',
              required: ['plaintext'],
              properties: {
                plaintext: { type: 'string' },
              },
            },
          ],
        },
        Tier: {
          type: 'object',
          required: [
            'id',
            'name',
            'daily_search_cap',
            'monthly_search_cap',
            'credit_per_search',
            'credit_per_batch_query',
          ],
          properties: {
            id: { type: 'string', enum: ['free', 'paid_starter', 'paid_pro'] },
            name: { type: 'string' },
            daily_search_cap: { type: 'integer', nullable: true },
            monthly_search_cap: { type: 'integer', nullable: true },
            credit_per_search: { type: 'integer' },
            credit_per_batch_query: { type: 'integer' },
          },
        },
        TopUpResponse: {
          type: 'object',
          required: [
            'developer_id',
            'previous_balance',
            'added_credits',
            'new_balance',
            'transaction_id',
          ],
          properties: {
            developer_id: { type: 'string', format: 'uuid' },
            previous_balance: { type: 'integer' },
            added_credits: { type: 'integer' },
            new_balance: { type: 'integer' },
            transaction_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      responses: {
        Error: {
          description: 'Error response',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  };
}

const searchParameters = [
  { name: 'queryType', in: 'query', required: true, schema: { enum: ['name', 'sku'] } },
  { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } },
  { name: 'limitPerChain', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10, default: 1 } },
];

const okArray = {
  '200': {
    description:
      'Scored rows. Each item is a camelCase public.products row minus runId, updatedAt, nameTokens, and normalizedName, plus score. Zero matches is an empty array.',
  },
};