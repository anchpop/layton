-- Sharing: a frozen, separately-encrypted copy of a book, readable by link.
--
-- A share is a *copy*, not a window. The client renders the book's current
-- state to plain prose (never the CRDT log — a Loro snapshot carries the whole
-- edit history, deleted sentences included), seals it under a key minted for
-- this share alone, and writes it here. Later edits to the book do not touch
-- it; revoking it deletes it.
--
-- The share key travels only in the URL fragment (`/s/<id>#<key>`), which
-- browsers never send to any server. So this table is like every other one in
-- Layton: ciphertext the server cannot read. The link is the capability — the
-- uuid says which row, the fragment says how to open it.
--
-- `wrapped_key` is the share key sealed under the *book's* key. It exists so
-- the owner can re-display or copy an old link from any device; a reader never
-- sees it (the public function below does not return it), and it grants a
-- reader nothing they do not already hold in the fragment.

create table public.shared_books (
  id          uuid primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  book_id     uuid not null references public.books (id) on delete cascade,
  -- Sealed JSON: { v, title, chapters: [{ title, body }] } under the share key.
  payload     text not null,
  -- The share key, sealed under the book's own key. For the owner only.
  wrapped_key text not null,
  created_at  timestamptz not null default now()
);

create index shared_books_book_idx on public.shared_books (book_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: the owner manages shares; the public reads them only
-- through the function below. There is deliberately no anonymous SELECT
-- policy — PostgREST would happily serve `select *` to the world, and while
-- every payload is ciphertext, handing out the full list of shares (their
-- count, sizes, and timing) to anyone who asks is not the same thing as
-- serving one row to someone who was given its unguessable id.
--
-- No UPDATE policy for anyone: a share is frozen at the moment it was made.
-- "Update the share" is create-new-and-revoke-old, which keeps old links dead
-- rather than quietly pointing at newer words.
-- ---------------------------------------------------------------------------
alter table public.shared_books enable row level security;

create policy shared_books_select on public.shared_books
  for select using (auth.uid() = owner_id);
create policy shared_books_insert on public.shared_books
  for insert with check (
    auth.uid() = owner_id
    -- Only your own book can be pointed at. Without this, an insert naming an
    -- arbitrary uuid would confirm (by succeeding) that someone's book exists.
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.owner_id = auth.uid()
    )
  );
create policy shared_books_delete on public.shared_books
  for delete using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- The public read path: one row, by id, payload only. Security definer is what
-- lets it bypass the absence of an anon SELECT policy, and returning a single
-- column is what keeps owner_id, book_id and wrapped_key out of anonymous
-- hands. Knowing the id *is* the authorization — it is 122 random bits that
-- only ever existed inside a link the owner chose to hand out.
-- ---------------------------------------------------------------------------
create or replace function public.shared_book_payload(p_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select payload from public.shared_books where id = p_id;
$$;

revoke all on function public.shared_book_payload(uuid) from public;
grant execute on function public.shared_book_payload(uuid) to anon, authenticated;
