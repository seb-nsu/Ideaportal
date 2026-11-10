import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { AI_IMPORT_FIELDS, commitImport, commitSchema, previewImport } from '../services/importAssist.js';

// Import of old ideas with AI support (R4-12): preview with AI cleanup and duplicate check,
// then the import of the rows a person confirmed. Only for admins.

const admin = { roles: ['admin' as const] };

export async function importAssistRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/admin/import/ai/preview',
    { bodyLimit: 8_000_000 },
    tenantHandler(async (ctx, req) => {
      const body = z
        .object({
          filename: z.string().min(1).max(200),
          data: z.base64(),
          mapping: z.partialRecord(z.enum(AI_IMPORT_FIELDS), z.number().int().min(0)).optional(),
        })
        .parse(req.body);
      return previewImport(ctx, body.filename, Buffer.from(body.data, 'base64'), body.mapping);
    }, admin),
  );

  app.post(
    '/api/admin/import/ai/commit',
    { bodyLimit: 8_000_000 },
    tenantHandler(async (ctx, req) => commitImport(ctx, commitSchema.parse(req.body)), admin),
  );
}
