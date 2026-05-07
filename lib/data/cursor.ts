import "server-only";

/** Opaque cursor for keyset pagination on `(updatedAt, id)`. */
export type Cursor = string & { readonly __cursorBrand: unique symbol };

/** Decoded cursor payload — the row position to seek past. */
export type CursorValue = { updatedAt: Date; id: string };

/**
 * Encode a row position as an opaque base64url cursor.
 *
 * @param value - The row position to seek past.
 * @returns Opaque cursor string.
 */
export function encodeCursor(value: CursorValue): Cursor {
  const json = JSON.stringify({
    u: value.updatedAt.toISOString(),
    i: value.id,
  });
  return Buffer.from(json, "utf8").toString("base64url") as Cursor;
}

/**
 * Decode a cursor previously produced by {@link encodeCursor}. Returns
 * null on malformed input — callers treat that as "first page".
 *
 * @param cursor - Opaque cursor string from the client (or null/undefined for first page).
 * @returns Row position or null.
 */
export function decodeCursor(
  cursor: string | null | undefined,
): CursorValue | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    return { updatedAt: new Date(parsed.u), id: parsed.i };
  } catch {
    return null;
  }
}

/** Decoded cursor payload for `(order, id)` pagination. */
export type OrderCursorValue = { order: number; id: string };

/**
 * Encode an `(order, id)` cursor.
 *
 * @param value - The row position to seek past.
 * @returns Opaque cursor.
 */
export function encodeOrderCursor(value: OrderCursorValue): Cursor {
  const json = JSON.stringify({ o: value.order, i: value.id });
  return Buffer.from(json, "utf8").toString("base64url") as Cursor;
}

/**
 * Decode an `(order, id)` cursor produced by {@link encodeOrderCursor}.
 *
 * @param cursor - Opaque cursor string from the client.
 * @returns Row position or null on malformed input.
 */
export function decodeOrderCursor(
  cursor: string | null | undefined,
): OrderCursorValue | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { o?: unknown; i?: unknown };
    if (typeof parsed.o !== "number" || typeof parsed.i !== "string") return null;
    return { order: parsed.o, id: parsed.i };
  } catch {
    return null;
  }
}
