-- End-to-end encryption.
--
-- Until now the server held prose it could read: `books.title` in the clear,
-- and `book_updates.payload` as base64 Loro bytes anyone with database access
-- could decode. Both are now ciphertext produced in the browser under a key the
-- server never sees, derived from a master password that is never transmitted.
--
-- What the server can still see, and always will
-- ----------------------------------------------
-- Which account owns how many books, when each was created, when each was last
-- written in, whether one is archived, and the size and timing of every update.
-- Encrypting content does not hide that content exists. It is worth stating
-- plainly rather than implying otherwise.
--
-- No plaintext path survives
-- --------------------------
-- Existing rows cannot be re-encrypted: they were written before any key
-- existed, so there is nothing to encrypt them *with*. They are deleted here
-- rather than left behind, which is what lets `title_cipher` and `wrapped_key`
-- be NOT NULL. A nullable "might be plaintext" column would have kept a
-- decrypt-or-fall-back branch alive in the client forever, and that branch is
-- exactly how a plaintext write sneaks back in years later.

-- ---------------------------------------------------------------------------
-- The one destructive step. Cascades to book_updates.
-- ---------------------------------------------------------------------------
delete from public.books;

-- ---------------------------------------------------------------------------
-- user_keys: two random content keys, each sealed under the master password.
--
-- Both are AES-GCM keys generated in the browser and never sent anywhere in the
-- clear. `wrapped_key` unwraps a book's key for everyday work; the client keeps
-- it on the device so ordinary books open without a prompt. `wrapped_private_key`
-- does the same for private books and is deliberately NOT kept — it lives in
-- memory only, so private books disappear when the vault locks.
--
-- Two keys rather than one, because the difference between an ordinary book and
-- a private one is precisely *which key is currently in memory*. One key could
-- not express it.
--
-- `salt` and `iterations` are the PBKDF2 parameters that turn the password into
-- the key these two are sealed under. Storing iterations rather than hardcoding
-- them means the cost can be raised later without stranding existing accounts.
-- ---------------------------------------------------------------------------
create table public.user_keys (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  salt                text not null,
  iterations          integer not null,
  wrapped_key         text not null,
  wrapped_private_key text not null,
  created_at          timestamptz not null default now()
);

alter table public.user_keys enable row level security;

create policy user_keys_select on public.user_keys
  for select using (auth.uid() = user_id);
create policy user_keys_insert on public.user_keys
  for insert with check (auth.uid() = user_id);
-- Update is what a password change needs: the same two keys, resealed.
create policy user_keys_update on public.user_keys
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Delete exists only for "erase everything and start again". There is no
-- recovery key by design, so without this an account whose password is
-- forgotten would be permanently stuck at a prompt it can never satisfy.
create policy user_keys_delete on public.user_keys
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- updated_at is now driven entirely by the log.
--
-- `books_touch_updated_at` fired when the title column changed, so that
-- renaming a book counted as writing. Encryption made that trigger unworkable:
-- AES-GCM uses a fresh random IV every time, so re-sealing the *same* title
-- produces different ciphertext, and `old.title is distinct from new.title`
-- — the guard added in 20260801000000 precisely to stop a book being re-dated
-- by merely opening it — would be true on every single write.
--
-- The fix is not a cleverer guard. It is that the trigger was already
-- redundant: a rename edits the Loro document, which appends to book_updates,
-- which fires `book_updates_touch_book`. Renaming has always bumped updated_at
-- through the log. Dropping this leaves one source for "when you last wrote in
-- this book" — the writing itself — which is what the column has always
-- claimed to mean.
--
-- This has to come before the column changes below: the trigger is scoped to
-- `update of title`, so Postgres counts it as depending on that column and
-- refuses to drop the column out from under it.
-- ---------------------------------------------------------------------------
drop trigger books_touch_updated_at on public.books;
drop function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- books: an encrypted title, and the book's own key sealed under one of the
-- two account keys above.
--
-- There is no `is_private` column, and that is the point. Which of the two keys
-- `wrapped_key` is sealed under is not recorded anywhere — the client discovers
-- it by trying the everyday key and then, if it holds one, the private key.
-- A row it cannot open is a row it does not render.
--
-- So concealment is a property of the cryptography rather than of a UI
-- conditional someone can forget to write: with the vault locked there is no
-- flag to read, no count to display, and nothing in the response that
-- distinguishes a private book from a corrupted one.
-- ---------------------------------------------------------------------------
alter table public.books drop column title;
alter table public.books add column title_cipher text not null;
alter table public.books add column wrapped_key  text not null;
