-- Shares can be brought up to date.
--
-- 20260813000000 shipped shares with no UPDATE policy at all: a link was
-- frozen at the moment it was cut, and "newer words" meant a new link. That
-- kept old links from quietly changing underneath their readers — but it also
-- meant a typo fixed five minutes after sharing demanded a fresh link and a
-- re-send to everyone who had the old one.
--
-- This allows the owner to refresh a share in place. The id and the key are
-- unchanged, so the link already in a reader's hands simply starts showing the
-- current story. What does NOT change: a share is still a copy, not a window.
-- Nothing updates it but the owner's explicit act; readers never see
-- keystrokes, only pushed versions.
--
-- Reusing the share key for the new payload is the ordinary envelope pattern
-- (a fresh random IV per seal), the same way a book's key seals its whole
-- update log.

alter table public.shared_books add column updated_at timestamptz;
update public.shared_books set updated_at = created_at;
alter table public.shared_books alter column updated_at set not null;
alter table public.shared_books alter column updated_at set default now();

create policy shared_books_update on public.shared_books
  for update using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    -- Same guard as insert: without it, an update could repoint book_id at an
    -- arbitrary uuid and learn from the FK whether someone's book exists.
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.owner_id = auth.uid()
    )
  );
