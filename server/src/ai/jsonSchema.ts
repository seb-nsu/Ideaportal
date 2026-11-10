import { z } from 'zod';

// Strict JSON schema for structured output (R2-09); shared by the gateway and the prompt versions.

/** A schema the model providers accept for strict structured output. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'object' && n.properties) {
      n.additionalProperties = false;
      n.required = Object.keys(n.properties as object);
    }
    // Providers support only a subset of JSON schema; ranges are checked by zod afterwards.
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) {
      if (key in n && typeof n[key] !== 'object') delete n[key];
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(json);
  delete json.$schema;
  return json;
}
