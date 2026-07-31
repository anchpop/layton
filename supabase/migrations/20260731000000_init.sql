-- Layton: offline-first fiction writing, synced per account.
--
-- Design notes
-- ------------
-- Each book is ONE Loro CRDT document (chapters, their order, and their prose
-- all live inside it). The server never interprets that document; it only
-- stores an append-only log of opaque base64-encoded Loro byte payloads.
--
-- Two payload kinds share the log:
--   'update'   an incremental Loro update produced by a local edit
--   'snapshot' a full Loro export that supersedes every row before it
--
-- Reading a book = take the newest snapshot, then apply every update with a
-- higher id. Compaction writes a fresh snapshot and deletes the rows it
-- provably subsumes (see compact_book below).
--
-- Payloads are `text` (base64) rather than `bytea` so PostgREST round-trips
-- them losslessly without hex-escape handling on the client.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- books
-- ---------------------------------------------------------------------------
create table public.books (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  -- Denormalized cache of the title held inside the Loro doc. Lets the library
  -- list render without downloading every book. The Loro doc stays the source
  -- of truth; clients refresh this on change.
  title       text not null default 'Untitled',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create index books_owner_idx on public.books (owner_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- book_updates (the append-only Loro log)
-- ---------------------------------------------------------------------------
create table public.book_updates (
  id         bigint generated always as identity primary key,
  book_id    uuid not null references public.books (id) on delete cascade,
  -- Denormalized so row-level security needs no join to books.
  owner_id   uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('update', 'snapshot')),
  payload    text not null,
  created_at timestamptz not null default now()
);

create index book_updates_book_idx on public.book_updates (book_id, id);
create index book_updates_snapshot_idx
  on public.book_updates (book_id, id desc)
  where kind = 'snapshot';

-- ---------------------------------------------------------------------------
-- Row level security: a row is visible only to the account that owns it.
-- ---------------------------------------------------------------------------
alter table public.books        enable row level security;
alter table public.book_updates enable row level security;

create policy books_select on public.books
  for select using (auth.uid() = owner_id);
create policy books_insert on public.books
  for insert with check (auth.uid() = owner_id);
create policy books_update on public.books
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy books_delete on public.books
  for delete using (auth.uid() = owner_id);

create policy book_updates_select on public.book_updates
  for select using (auth.uid() = owner_id);
create policy book_updates_insert on public.book_updates
  for insert with check (auth.uid() = owner_id);
-- The log is append-only: no UPDATE policy. Deletes happen only through
-- compact_book(), which runs as security definer.
create policy book_updates_delete on public.book_updates
  for delete using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger books_touch_updated_at
  before update on public.books
  for each row execute function public.touch_updated_at();

-- Any write to a book's log bumps the book's updated_at, so the library list
-- can sort by genuine writing activity without the client managing it.
create or replace function public.touch_book_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.books set updated_at = now() where id = new.book_id;
  return new;
end;
$$;

create trigger book_updates_touch_book
  after insert on public.book_updates
  for each row execute function public.touch_book_on_update();

-- ---------------------------------------------------------------------------
-- compact_book: collapse the log into a single snapshot.
--
-- p_upto is the highest row id the calling client has already folded into the
-- Loro document it is snapshotting. Deleting rows at or below that id is safe
-- precisely because the new snapshot subsumes them. Rows above p_upto (a
-- concurrent writer's edits that this client has not seen) are left alone, so
-- no edit can be lost by compacting.
-- ---------------------------------------------------------------------------
create or replace function public.compact_book(
  p_book_id  uuid,
  p_upto     bigint,
  p_snapshot text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner       uuid;
  v_snapshot_id bigint;
begin
  select owner_id into v_owner from public.books where id = p_book_id;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'not authorized to compact book %', p_book_id
      using errcode = '42501';
  end if;

  -- Write the snapshot first: if the delete fails, we have a redundant
  -- snapshot (harmless) rather than a gap in the log (data loss).
  insert into public.book_updates (book_id, owner_id, kind, payload)
  values (p_book_id, v_owner, 'snapshot', p_snapshot)
  returning id into v_snapshot_id;

  delete from public.book_updates
  where book_id = p_book_id
    and id <= p_upto;

  return v_snapshot_id;
end;
$$;

revoke all on function public.compact_book(uuid, bigint, text) from public;
grant execute on function public.compact_book(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: clients subscribe to inserts on book_updates to receive a
-- collaborator's (or their other device's) edits live.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.book_updates;
