import { useCallback, useEffect, useState } from "react";

import { supabase, type BookRow } from "../lib/supabase";
import { deleteLocalBook } from "../lib/localStore";

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

  const deleteBook = useCallback(
    async (bookId: string) => {
      // Cascades to book_updates via the foreign key.
      const { error: err } = await supabase
        .from("books")
        .delete()
        .eq("id", bookId);
      if (err) {
        setError(err.message);
        return;
      }
      await deleteLocalBook(bookId);
      await refresh();
    },
    [refresh],
  );

  return { books, loading, error, refresh, createBook, deleteBook };
}
