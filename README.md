# Layton

A quiet, offline-first place to write fiction. Your work syncs to your account
across every device, merges without conflicts, and keeps working when the
network doesn't.

**Live:** https://layton.chadnauseam.com

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

## Architecture

```
Browser                          Supabase (Postgres)          Cloudflare
┌──────────────────────┐         ┌──────────────────┐         ┌──────────┐
│ ProseMirror          │         │ books            │         │ Workers  │
│   ↕ loro-prosemirror │         │ book_updates ────┼─Realtime│  Assets  │
│ Loro CRDT (one doc   │◄───────►│   (append-only   │         │ (static  │
│   per book)          │  REST   │    Loro log)     │         │  SPA)    │
│   ↕                  │         │ RLS: owner only  │         └──────────┘
│ IndexedDB            │         └──────────────────┘
│   snapshot + outbox  │
└──────────────────────┘
```

There is no server-side application code. Cloudflare serves static files; the
browser talks straight to Supabase, and Postgres row-level security is the
authorization boundary.

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

`book_updates` is an append-only log of opaque base64 Loro payloads, in two
kinds: incremental `update`s, and `snapshot`s that supersede everything before
them. Reading a book means taking the newest snapshot and applying every update
with a higher id.

**Ordering.** A client tracks a `watermark`: the highest row id applied *via an
ordered fetch*. Realtime messages are applied immediately for low latency but
never advance the watermark, because realtime delivery guarantees neither order
nor completeness. Every realtime event also schedules an ordered catch-up
(`id > watermark`), and only that path moves the watermark. Loro imports are
idempotent, so the fast path costs nothing in correctness — and a dropped
realtime message heals itself instead of becoming a permanently missing edit.

**Offline.** Local updates are written to an IndexedDB outbox *before* any
attempt to send them, so an edit survives a browser restart. A debounced
snapshot cache makes cold and offline opens instant.

**Compaction.** Once the log passes ~150 rows, the client calls `compact_book`,
which writes a fresh snapshot and deletes rows at or below the watermark the
client passes in. That bound is what makes it safe: the client provably already
folded those rows into the snapshot, and a concurrent writer's newer rows are
left untouched.

## Sign-in, and why passkeys matter here

Email magic links work, but they cannot get you into the *installed* app on
iOS. A home-screen PWA runs in its own storage context; a link opened from Mail
launches Safari, the session lands there, and the installed app never sees it.

So the first sign-in offers to create a passkey, and that is what the installed
app uses from then on. Supabase issues discoverable credentials
(`residentKey: required`), so signing in needs no email typed first — just the
device prompt.

WebAuthn binds a credential to one `rp_id`, which must match the origin's host.
That pins passkeys to a single canonical domain (`layton.chadnauseam.com`) and
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

Add your dev origin to `additional_redirect_urls` in `supabase/config.toml`,
otherwise magic links bounce. The service worker is disabled in dev
(`devOptions.enabled: false`) so you are not debugging a stale cache; run
`pnpm build && pnpm preview` to exercise it.

## Deploying

```bash
pnpm build
npx wrangler deploy
```

`wrangler.jsonc` is assets-only with `not_found_handling:
single-page-application`, so client-side routes resolve on hard refresh. It
serves one custom domain; adding a `routes` entry is what disables the
`workers.dev` URL, which is deliberate (see passkeys above).

Because `VITE_*` values are baked into the bundle at build time, the publishable
key ships to the browser — which is what it is for. Every table is protected by
RLS keyed on `auth.uid()`; the key alone grants nothing.

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
    sync.ts        the sync engine (watermark, outbox, compaction)
    localStore.ts  IndexedDB snapshot cache + outbox
    schema.ts      ProseMirror schema, deliberately small
    bytes.ts       base64 bridge between Loro and PostgREST
    passkey.ts     WebAuthn enrolment, sign-in, and management
    pwa.ts         installed-app and platform detection
  hooks/           auth (with offline fallback), library, passkey gate,
                   and CRDT-to-React subscriptions
  components/      Auth, PasskeySetup, PasskeyPanel, Library, BookView,
                   ChapterList, Editor, UpdatePrompt
    ui/            shadcn components (owned, edited in place)
supabase/migrations/
```
