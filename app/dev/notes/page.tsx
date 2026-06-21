import { notFound } from "next/navigation";
import { NotesPrototype } from "./NotesPrototype";

export const dynamic = "force-dynamic";

/**
 * Dev-only, non-functional prototype for the Piyaz Notes feature. Returns 404
 * outside of `next dev`. Renders the proposed Notes UI with mock data only —
 * no DB, no MCP, no network. See `docs/superpowers/specs/2026-06-20-piyaz-notes-design.md`.
 *
 * @returns The Notes prototype frame, or a 404 in production.
 */
export default function NotesPrototypePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <NotesPrototype />;
}
