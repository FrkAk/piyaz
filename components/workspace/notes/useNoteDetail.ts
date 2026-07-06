"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoteFullResult, NoteTreeRow } from "@/lib/data/note";
import { notePlaceholderFromRow } from "@/lib/query/note-cache";
import { noteKeys } from "@/lib/query/keys";
import { fetchNoteDetail } from "@/lib/query/queries";

/**
 * Detail query for one note, placeholder-seeded from the cached tree list
 * so the pane renders instantly on select. The tree row carries no `body`,
 * so the placeholder body is empty until the detail fetch resolves; editing
 * and autosave must stay gated on `isPlaceholderData`. Mount only with a
 * live selection — never key a query on an empty id.
 *
 * @param projectId - Owning project id.
 * @param noteId - Selected note id.
 * @returns The detail result, its placeholder flag, and the fetch error flag.
 */
export function useNoteDetail(projectId: string, noteId: string) {
  const qc = useQueryClient();

  const { data, isPlaceholderData, isError } = useQuery({
    queryKey: noteKeys.detail(projectId, noteId),
    queryFn: fetchNoteDetail(qc, projectId, noteId),
    placeholderData: (): NoteFullResult | undefined => {
      const rows = qc.getQueryData<NoteTreeRow[]>(noteKeys.list(projectId));
      const row = rows?.find((r) => r.id === noteId);
      return row ? notePlaceholderFromRow(projectId, row) : undefined;
    },
  });

  return { data, isPlaceholderData, isError };
}
