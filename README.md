# Layton

A quiet, offline-first place to write fiction. Your work syncs to your account
across every device, merges without conflicts, keeps working when the network
doesn't, and is encrypted end to end by default. Opt-in AI continuation and MCP connections
let the services you authorize read the text they need.

**Live:** https://layton.space

---

## What it does

- **Write offline.** Everything is stored locally first. Close the laptop mid-
  sentence on a plane, open it on your phone later, and both sides merge.
- **Chapters.** Drag to reorder, double-click to rename, running word count.
- **Book typesetting.** Smart quotes, em dashes (`--`), ellipses (`...`), scene
  breaks (`***` on an empty line), first-paragraph indent suppression.
- **Focus mode** (`⌘.`) fades the interface away. `⌘\` toggles the sidebar.
- **Light and dark**, following the system by default.
- **Works on a phone.** The chapter panel becomes a drawer; the writing surface
  gets the whole screen.
- **Installable.** Add it to your home screen or dock and it works with no
  network at all — the app shell, the editor, and the CRDT engine are all
  precached.
- **Passkeys.** Sign in with Face ID, Touch ID, or your device lock.
- **End-to-end encrypted, always.** Every chapter, every edit, and every title
  is sealed in the browser under a master password that never leaves it. There
  is no plaintext storage mode. An optional MCP connection can delegate selected
  decryption keys to the hosted server, with explicit consent.
- **Private books.** Mark a book private and it vanishes from the library
  fifteen minutes after you stop writing, or the moment you press the lock. A
  locked library gives no sign that private books exist at all.
- **Continue with AI.** A button in the editor asks a large base model to
  keep writing from the caret. Suggested prose arrives with a wash of
  background color until you edit it into your own, and the wash is stripped
  from shared copies. This is a deliberate exception to end-to-end
  encryption — the model must read the text it continues — so the first press
  says exactly that; requests carry the prose alone, nothing about the account.
- **Share a copy by link.** One link, readable by anyone who holds it, no
  account needed. The copy is frozen at the moment you cut the link, encrypted
  under a key that travels only in the URL fragment — the part after the `#`
  that browsers never send — so the server cannot read what it is serving.

- **Connect an AI app with MCP.** OAuth grants read and edit access for 12 months.
  The password stays in the browser; the hosted MCP receives delegated keys.
  Private stories require a separate, unchecked consent choice. Revoke a
  connection from Account → AI connections. Edits carry the AI app’s name in
  the encrypted history and appear in each story’s AI edit history panel.
  [Setup and security](docs/mcp.md).

## Architecture

```
Browser                          Supabase (Postgres)          Cloudflare
┌──────────────────────┐         ┌──────────────────┐         ┌──────────┐
│ ProseMirror          │         │ user_keys        │         │ Workers  │
│   ↕ loro-prosemirror │         │ books            │         │  Assets  │
│ Loro CRDT (one doc   │         │ book_updates ────┼─Realtime│ (static  │
│   per book)          │◄───────►│   (append-only   │         │  SPA)    │
│   ↕ seal / unseal    │  REST   │    log of sealed │         └──────────┘
│ IndexedDB            │         │    envelopes)    │
│   sealed snapshot    │         │ RLS: owner only  │
│   + outbox           │         └──────────────────┘
└──────────────────────┘
        ▲
        └── plaintext for writing; opt-in MCP can also decrypt authorized books
```

The writing app talks straight to Supabase, and Postgres row-level security is
its authorization boundary. Cloudflare serves the app, relays encrypted AI
continuations, and hosts the optional OAuth MCP (see [MCP](docs/mcp.md)). For
ordinary writing, row-level security remains the authorization boundary — but no longer the only one. Everything crossing that
arrow is ciphertext, so a compromised database, a leaked backup, or a
subpoenaed Postgres instance yields sealed bytes and timestamps.

### One Loro document per book

Inside each document:

```
meta      LoroMap         { title }
chapters  LoroMovableList [ LoroMap { id, title } ]   ← the index
bodies    LoroMap         { [chapterId]: LoroMap }    ← ProseMirror trees
```

The chapter **index** and the chapter **prose** live in sibling subtrees on
purpose. Loro delivers events for a container's entire subtree, so nesting
bodies inside the chapter list would wake the sidebar on every keystroke. Split
this way, typing notifies only `bodies`.

Reordering uses a *movable* list, so two devices dragging chapters around
converge instead of duplicating or dropping one.

Each editor binds to a single chapter's body container by `ContainerID`. Those
IDs are identical on every peer, which is what lets a chapter opened on two
devices resolve to the same CRDT container.

### Sync protocol

`book_updates` is an append-only log of sealed Loro payloads, in two kinds:
incremental `update`s, and `snapshot`s that supersede everything before them.
Reading a book means taking the newest snapshot and applying every update with a
higher id. The payloads are opaque to the server in the strong sense — they are
AES-GCM envelopes under the book's key (see Encryption), so `kind` and `id` are
the only fields Postgres can act on, which is all compaction needs.

**Ordering.** A client tracks a `watermark`: the highest row id applied *via an
ordered fetch*. Realtime messages are applied immediately for low latency but
never advance the watermark, because realtime delivery guarantees neither order
nor completeness. Every realtime event also schedules an ordered catch-up
(`id > watermark`), and only that path moves the watermark. Loro imports are
idempotent, so the fast path costs nothing in correctness — and a dropped
realtime message heals itself instead of becoming a permanently missing edit.

**Offline.** Local updates are sealed and then written to an IndexedDB outbox
*before* any attempt to send them, so an edit survives a browser restart and is
ciphertext the moment it does. Sealing once on the way in is also why flushing
is a verbatim upload rather than a second pass. A debounced snapshot cache — the
snapshot sealed under the same key — makes cold and offline opens instant.

**Compaction.** Once the log passes ~150 rows, the client calls `compact_book`,
which writes a fresh snapshot and deletes rows at or below the watermark the
client passes in. That bound is what makes it safe: the client provably already
folded those rows into the snapshot, and a concurrent writer's newer rows are
left untouched.

## Encryption

One master password, chosen once. Everything else follows from it.

```
master password
   │  PBKDF2-SHA256, 600,000 rounds, per-account salt
   ▼
master key ──seals──┬──▶ everyday key ──seals──▶ ordinary books' keys
                    └──▶ private key  ──seals──▶ private books' keys
                                                        │
                                          each book key seals that book's
                                          title, its update log, and its
                                          cached snapshot
```

Both account keys are random and stored only in sealed form, in `user_keys`.
The password and derived master key are never transmitted. Optional MCP consent
delegates the random everyday account key and, only if selected, the private
account key to the hosted Worker.

**Why two account keys.** The difference between an ordinary book and a private
one is precisely *which key is currently in memory*. The everyday key is kept on
the device as a non-extractable `CryptoKey` in IndexedDB, so ordinary books open
with no prompt, offline, forever. Without an MCP grant, the private key is never persisted unwrapped anywhere —
it lives in one module variable and dies with the tab, the idle timer, or the
lock button. One key could not express that difference; a boolean column could
have, but see below.

**Why a per-book key.** It makes marking a book private a single column update
rather than a re-encryption of its entire history. Only the wrapping moves from
one account key to the other; the book's own key is untouched, so every envelope
already written under it stays valid.

### How private books hide

There is no `is_private` column. Nothing anywhere records which account key a
book belongs to. The client finds out by trying the everyday key, then — if it
holds one — the private key, and a row it cannot open is a row it does not
render.

That is the whole mechanism, and it is deliberately cryptographic rather than
conditional. With the private key put away there is no flag to read, no count to
redact, and no `if (!book.isPrivate)` that a future refactor can drop. A private
book fails at exactly the point a corrupted row would, and is dropped in exactly
the same silence: no placeholder, no "2 hidden", nothing to notice.

You mark a book private from its own sidebar, under the title — it is a
property of that book, like its name. The library's context menu offers the
same move for when you are looking at all of them at once. Either way it needs
the private key, and both places fold asking for the master password into the
same gesture rather than sending you elsewhere to unlock first.

The lock control in the library header is always visible, whether or not the
account has any private books. Hiding it would be the tell.

Because only the wrapping moves when a book is made private, the *old* wrapping
stays cryptographically valid forever — so a device still holding the cached
everyday-key copy would go on opening a book that is no longer meant to be
visible to it, and nothing would fail to tell it so. The server is therefore
asked for the wrapping first and the cached copy is the fallback, not the
preference; an open tab re-checks when it is returned to and when the network
comes back. Two windows remain by construction: a device with no connection
keeps whatever access it last had, and a key already inside a running tab
cannot be taken back out of it.

### Locking

The private key is dropped after **15 minutes** without a keystroke, pointer
event, or scroll — checked against wall-clock timestamps rather than a timer,
because a throttled background tab or a suspended laptop would otherwise stretch
that window. The lock button does the same thing immediately.

When a private book's editing page is open, locking rebuilds the sync engine
rather than hiding the page. That is the only way to be sure: a `LoroDoc` that
has imported a chapter cannot be emptied, so the document itself is thrown away
and the screen becomes a password prompt. Ordinary books sit the transition out
untouched — losing your caret and your place on the page for a key that never
applied to them would be a cost with no benefit.

Signing out forgets the device key. The cached books stay in IndexedDB, which is
safe precisely because they are sealed; the next sign-in asks for the master
password to get the key back.

### Sharing a story

Sharing hands someone a book without handing them an account, and without
handing the server a single readable word. From the book's sidebar: *Share a
copy* mints a link like

```
https://layton.space/s/<uuid>#<key>
```

Everything about the mechanism is in that shape. The uuid names a row in
`shared_books`; the key after the `#` decrypts it, and a URL fragment is never
sent by the browser — not to Layton's host, not to Supabase, not into server
logs. The page fetches ciphertext and decrypts it locally, so a shared story is
exactly as opaque to the server as the book it came from. Revoking the link
deletes the row; the owner's copies of old links are kept re-showable by
sealing each share's key under the book's own key.

Three decisions worth writing down:

- **A share is a copy, not a window.** The payload is set when the link is cut
  and changes only when the author pushes an update to it — same link, same
  key, new words. Nothing a reader holds ever shows keystrokes as they happen;
  "anyone with the link can read my drafts as I write them" is a different
  feature, deliberately not this one.
- **The copy is the book *rendered*, never the CRDT.** A Loro snapshot is the
  history: every deleted paragraph and discarded phrasing, recoverable by
  anyone with a debugger. What was written and unwritten was never offered to
  the reader, so the export walks the current state into plain ProseMirror
  JSON. A side effect is that the reader page needs no CRDT engine — it loads
  a few kilobytes, not Loro's three-megabyte wasm.
- **The public can fetch one row, not list any.** `shared_books` has no
  anonymous SELECT policy; readers go through a `security definer` function
  that takes an id and returns the payload column alone. Every payload is
  ciphertext, but serving the world a listable table of who shared how much,
  when, is not the same thing as serving one row to someone who was handed its
  unguessable id.

### What the server still sees

Encrypting content does not hide that content exists. Anyone with database
access learns which account owns how many books, when each was created, when
each was last written in, whether one is archived, and the size and timing of
every edit. Titles and prose are opaque; the shape of the writing life around
them is not.

Using **Continue with AI** additionally sends the current chapter's text (up
to the caret) to the model server — sealed to that server's own public key, so
the Cloudflare Worker in between relays ciphertext it cannot open, and the
reply comes back sealed to a key only that browser tab held. The Worker checks
that the request comes from a signed-in session and forwards the envelope
alone; nothing is logged or stored, and the model request is not tied to the
account. Only the machine running the model reads the prose, which is the
irreducible cost of asking a model to continue it.

Authorizing MCP additionally allows the hosted Worker and connected AI app to
read current text from the selected categories of stories. This access includes
future synced edits and lasts until expiration or revocation; locking your
browser does not revoke it. [MCP security and revocation](docs/mcp.md) describes
the delegated keys and database capability.

### There is no recovery

No recovery key, no reset, no support path. MCP delegation is for authorized
story reads; it does not offer a password or vault-recovery mechanism. The setup
screen explains the lack of recovery and asks for a tick.

The only escape is demolition: an "erase everything" path on the unlock screen
that deletes every book and lets a new vault be created over the empty space.
It is offered because an account with no way forward at all is worse than an
honest one-way door.

## Sign-in, and why passkeys matter here

Email magic links work, but they cannot get you into the *installed* app on
iOS. A home-screen PWA runs in its own storage context; a link opened from Mail
launches Safari, the session lands there, and the installed app never sees it.

So the first sign-in offers to create a passkey, and that is what the installed
app uses from then on. Supabase issues discoverable credentials
(`residentKey: required`), so signing in needs no email typed first — just the
device prompt.

WebAuthn binds a credential to one `rp_id`, which must match the origin's host.
That pins passkeys to a single canonical domain (`layton.space`) and
is why the `workers.dev` route is switched off: two origins would mean passkeys
that silently fail on one of them.

Local passkey testing therefore needs `rp_id` and `rp_origins` in
`supabase/config.toml` temporarily pointed at `localhost`. Magic links work
locally without any change.

### Staying signed in offline

Supabase treats a session whose access token has genuinely expired as dead once
the refresh call fails — correct for a normal web app, wrong for this one. It
would strand you at a sign-in screen you cannot complete, with a finished
chapter sitting in IndexedDB behind it.

Two things prevent that. Tokens last a week (`jwt_expiry`), and when a refresh
fails *for network reasons specifically*, the app falls back to the identity it
remembered on this device and keeps writing. That grants the client nothing:
row-level security still gates every read and write on the server, and edits
made in the meantime queue in the outbox until the connection returns.

## The PWA

`vite-plugin-pwa` in `generateSW` mode precaches the whole shell — including
Loro's ~3 MB wasm, which needs `maximumFileSizeToCacheInBytes` raised well past
Workbox's 2 MiB default. Without that the file is dropped silently and the
editor cannot open offline, which is the entire point.

Updates install in the background but never reload the page on their own: a
swap mid-sentence would tear down the live editor and lose your cursor and
scroll position. A new build waits behind a quiet prompt, and open tabs check
hourly.

Supabase calls are pinned to `NetworkOnly`. A stale cached API response would
be worse than a clean failure, because sync already knows how to handle
failure.

## Interface

Built on [shadcn/ui](https://ui.shadcn.com) (Radix under the hood). Two things
were adapted rather than taken as-is:

**The palette.** shadcn ships a neutral grey scale. Layton's tokens are
remapped to the warm paper palette in `src/index.css`, so every component —
sidebar, dialogs, toasts — inherits it. shadcn's token names are the single
source of truth for chrome; a couple of prose-only tokens (`--prose-faint`,
`--selection`) sit alongside them for the writing surface.

**The sidebar shortcut.** shadcn's sidebar binds ⌘B, which is bold in the
editor. It is rebound to ⌘\ in `components/ui/sidebar.tsx` — a writer reaching
for emphasis should never get a sliding panel instead.

Theme switching uses shadcn's `.dark` class rather than a media query, so
"system" is resolved to a concrete class in `ThemeToggle` and again in a
pre-paint script in `index.html` (no flash of the wrong background at night).

On a phone the sidebar renders as a drawer and closes itself when you pick a
chapter. The measure is fluid below 640px — what matters on a small screen is
that the text is not fighting the edges.

## Local development

```bash
pnpm install
cp .env.example .env.local     # fill in your Supabase URL + publishable key
pnpm dev
```

Run against your own Supabase project:

```bash
pnpx supabase link --project-ref <ref>
pnpx supabase db push           # applies supabase/migrations/
pnpx supabase config push       # site_url + redirect allow-list
```

Note that `20260810000000_end_to_end_encryption.sql` **deletes every row in
`books`**. It has to: rows written before encryption existed cannot be
re-encrypted, because there is no key they were ever encrypted under. Deleting
them is what lets `title_cipher` and `wrapped_key` be `NOT NULL`, and what keeps
a decrypt-or-fall-back branch out of the client permanently.

Add your dev origin to `additional_redirect_urls` in `supabase/config.toml`,
otherwise magic links bounce. The service worker is disabled in dev
(`devOptions.enabled: false`) so you are not debugging a stale cache; run
`pnpm build && pnpm preview` to exercise it.

## Deploying

```bash
pnpm build
npx wrangler deploy
```

`wrangler.jsonc` serves assets with `not_found_handling:
single-page-application`, so client-side routes resolve on hard refresh. The
Worker runs the AI relay, OAuth and MCP endpoints; MCP also requires the migration
and KV setup in [docs/mcp.md](docs/mcp.md). It
serves one custom domain; adding a `routes` entry is what disables the
`workers.dev` URL, which is deliberate (see passkeys above).

Because `VITE_*` values are baked into the bundle at build time, the publishable
key ships to the browser — which is what it is for. Every table is protected by
RLS keyed on `auth.uid()`; the key alone grants nothing. And since the content
behind that boundary is sealed, an RLS mistake would leak ciphertext rather than
prose — the two protections fail independently, which is the point of having
both.

## Keyboard

| Key | Action |
| --- | --- |
| `⌘B` / `⌘I` | Bold / italic |
| `⌘Z` / `⇧⌘Z` | Undo / redo (CRDT-aware — only ever your own edits) |
| `⌘\` | Toggle sidebar |
| `⌘.` | Focus mode |
| `⌘⌥2` | Section heading |

## Layout

```
src/
  lib/
    book.ts        Loro document schema + chapter operations
    sync.ts        the sync engine (watermark, outbox, compaction, sealing)
    share.ts       reading a shared story: fragment key, fetch, unseal. No Loro
    sharePublish.ts  making one: render, seal, publish, list, revoke
    localStore.ts  IndexedDB sealed-snapshot cache, outbox, and device key
    crypto.ts      the sealed envelope and the key derivations. All WebCrypto
    vault.ts       which keys are held, how they are got, and when they go
    schema.ts      ProseMirror schema, deliberately small
    autocomplete.ts  continue-with-AI: prompt from the caret, fetch, insert
    bytes.ts       base64 bridge between Loro and PostgREST
    passkey.ts     WebAuthn enrolment, sign-in, and management
    pwa.ts         installed-app and platform detection
  hooks/           auth (with offline fallback), library, passkey gate, vault
                   gate, and CRDT-to-React subscriptions
  components/      Auth, PasskeySetup, PasskeyPanel, VaultSetup, VaultUnlock,
                   UnlockPrivate, Library, BookView, ChapterList, Editor,
                   BookSharing, SharedStory (the public reader), UpdatePrompt
    ui/            shadcn components (owned, edited in place)
supabase/migrations/
worker/index.ts     OAuth MCP routing and consent
worker/mcp/         delegated read access, story rendering, and tools
worker/relay.ts     the /api/complete proxy: session check, then the model
```
