# Layton

A quiet, offline-first place to write fiction. Your work syncs to your account
across every device, merges without conflicts, and keeps working when the
network doesn't.

**Live:** https://layton.nauseam.workers.dev

---

## What it does

- **Write offline.** Everything is stored locally first. Close the laptop mid-
  sentence on a plane, open it on your phone later, and both sides merge.
- **Chapters.** Drag to reorder, double-click to rename, running word count.
- **Book typesetting.** Smart quotes, em dashes (`--`), ellipses (`...`), scene
  breaks (`***` on an empty line), first-paragraph indent suppression.
- **Focus mode** (`⌘.`) fades the interface away. `⌘\` toggles the sidebar.
- **Light and dark**, following the system by default.

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
otherwise magic links bounce.

## Deploying

```bash
pnpm build
npx wrangler deploy
```

`wrangler.jsonc` is assets-only with `not_found_handling:
single-page-application`, so client-side routes resolve on hard refresh.

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
  hooks/           auth, library, and CRDT-to-React subscriptions
  components/      Auth, Library, BookView, ChapterList, Editor
supabase/migrations/
```
