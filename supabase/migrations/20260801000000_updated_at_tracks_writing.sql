-- updated_at means "when you last wrote in this book", not "when this row was
-- last touched". The library shows it as "Edited 3 days ago" and sorts by it,
-- so anything that stamps it without a word being written is a lie about the
-- author's own history.
--
-- The trigger fired on every UPDATE, which was harmless only because a title
-- edit was the sole thing the client ever updated. Archiving is an update too,
-- and one that must not count: shelving a book — or undoing that — would push
-- it to the top of the library claiming it was edited today, and the real date
-- of its last sentence would be gone with no way to recover it.
--
-- `update of title` is the whole fix, and it is worth preferring over a test
-- inside the function. Postgres fires a column-scoped trigger only when that
-- column appears in the UPDATE's SET list, so the two writes that must not be
-- caught are excluded by construction rather than by remembering to exclude
-- them:
--
--   * archiving sets only archived_at, so this never runs and the timestamp
--     survives untouched;
--   * book_updates_touch_book sets only updated_at, so its now() stands as
--     written — prose keeps driving the library's order, which is the entire
--     reason the column exists.
--
-- A guard in the function body would have had to special-case both, and would
-- have gone wrong the moment a third kind of write appeared.
--
-- The WHEN clause covers the case `update of` cannot: Postgres fires on a
-- column being *mentioned*, not changed, and syncTitleToLibrary resends the
-- title on a timer after a book is opened whether or not it was touched. So
-- merely opening a book to reread a chapter has been re-dating it to today.
-- Requiring the value to actually differ makes the column mean what the
-- library has always claimed it means.
drop trigger books_touch_updated_at on public.books;

create trigger books_touch_updated_at
  before update of title on public.books
  for each row
  when (old.title is distinct from new.title)
  execute function public.touch_updated_at();
