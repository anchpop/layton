import { useCallback, useEffect, useState } from "react";

import { supabase, type BookRow } from "../lib/supabase";

export function useLibrary(userId: string | null) {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error: err } = await supabase
      .from("books")
      .select("*")
      .is("archived_at", null)
      .order("updated_at", { ascending: false });

    if (err) setError(err.message);
    else {
      setBooks((data ?? []) as BookRow[]);
      setError(null);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBook = useCallback(
    async (title: string): Promise<BookRow | null> => {
      if (!userId) return null;
      const { data, error: err } = await supabase
        .from("books")
        .insert({ owner_id: userId, title })
        .select()
        .single();
      if (err) {
        setError(err.message);
        return null;
      }
      await refresh();
      return data as BookRow;
    },
    [userId, refresh],
  );

  /**
   * Takes a book off the shelf without destroying a word of it.
   *
   * `refresh` already filters on `archived_at is null`, so stamping the column
   * is the whole operation — the row, its update log, and the local snapshot
   * all stay exactly where they are. Nothing here is a one-way door: clearing
   * the column puts the book back, whenever there is a screen that does it.
   */
  const setArchived = useCallback(
    async (bookId: string, archived: boolean) => {
      const { error: err } = await supabase
        .from("books")
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq("id", bookId);
      if (err) {
        setError(err.message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  return { books, loading, error, refresh, createBook, setArchived };
}
