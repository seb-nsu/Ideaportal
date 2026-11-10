// Opaque cursors for keyset pagination (R3-28). A cursor holds the sort key values and the id of
// the last row of a page; the next page continues strictly after that row, so new or changed
// rows never shift or repeat entries the way OFFSET does.
import { z } from 'zod';
import { badRequest } from './errors.js';
import { m } from '../i18n/index.js';

export type CursorKey = (string | number | null)[];

const cursorShape = z.object({ v: z.literal(1), s: z.string(), k: z.array(z.union([z.string(), z.number(), z.null()])).max(5) });

/** `sort` binds the cursor to one sort order; a cursor of another order is rejected. */
export function encodeCursor(sort: string, key: CursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, s: sort, k: key })).toString('base64url');
}

export function decodeCursor(cursor: string, sort: string): CursorKey {
  try {
    const parsed = cursorShape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.s === sort) return parsed.k;
  } catch {
    // fall through
  }
  throw badRequest(m('ideas.invalidCursor'));
}

/** Query parameters shared by paginated lists. Without limit and cursor a list keeps its old array response. */
export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
