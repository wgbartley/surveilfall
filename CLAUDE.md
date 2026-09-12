# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SurveilFall is a self-hosted, Scryfall-compatible MTG card search server. It mirrors a subset of
the Scryfall API (`/cards/search`, `/cards/:id`, `/bulk-data`) against a local MariaDB copy of
Scryfall's bulk card data, plus a small server-rendered frontend for searching and viewing cards.
There is no framework beyond Express — no build step, no bundler, no ORM.

## Commands

- `npm start` — run the server (`node server.js`), listens on `PORT` (default 3000).
- `npx nodemon server.js` — dev mode with auto-restart (config in `nodemon.json`; ignores
  `downloads/` and `public/`).
- No lint or test setup exists (`npm test` is a stub that exits 1).
- `docker compose up --build` — build and run the containerized app (reads `.env` for DB/admin
  config; see docker-compose.yml).

Required environment (`.env`, loaded via `process.loadEnvFile()` — Node 22+ builtin, no dotenv
dependency): `DB_HOST`, `DB_PORT` (optional, default 3306), `DB_NAME`, `DB_USER`, `DB_PASS`,
`ADMIN_PASSWORD`, `USER_AGENT` (sent to Scryfall's API per their API etiquette guidelines).

## Updating card data

Two ways to (re)populate the database from Scryfall's bulk data:

1. **Admin UI** (production path): visit `/admin` (HTTP Basic Auth, any username + `ADMIN_PASSWORD`
   as password), click import. This runs `startImportJob()` in `server.js` as a background job —
   downloads Scryfall's `default_cards` bulk file, drops and recreates `cards`/`card_search`,
   streams the file in, and records metadata. Progress is polled from the browser via
   `GET /admin/import/status`, since the download+import takes minutes and a single long-lived
   HTTP response is unreliable through browsers/proxies.
2. **CLI scripts** (local/manual path):
   - `node download-data-files.js` — downloads all bulk-data sets listed by Scryfall's
     `/bulk-data` endpoint into `downloads/` (skips files already on disk within 5% of expected size).
   - `node import-bulk-cards.js downloads/<file>.json` — drops and recreates `cards`/`card_search`,
     then streams the given bulk JSON file into the DB in batches of 1000 rows.

Both import paths are destructive: they `DROP TABLE cards` / `card_search` before reloading, so a
full re-import is the only supported way to refresh data (no incremental/diff updates).

## Architecture

**Database.** Two tables drive everything, created by whichever import path runs:
- `cards (id, data)` — `data` is the raw Scryfall card JSON as a string (`LONGTEXT`), keyed by
  Scryfall card ID. This is the source of truth; routes `JSON.parse` it on read.
- `card_search (id, name, set_code, set_name, collector_number, released_at, cmc, power,
  toughness)` — a denormalized, indexed projection of `cards` used for all search/lookup queries
  so full-table JSON scans are never needed on the hot path.
- `meta (k, v)` — key/value store for import bookkeeping (`cards_updated_at`, `cards_count`,
  `source_updated_at`), read by `GET /meta` and survives re-imports (not dropped).

Because `cards.data` is the only place full card JSON lives, any route that needs full card
objects first queries `card_search` for matching IDs, then batch-fetches JSON via
`fetchCardData()` in `server.js` — never join against `cards` directly for filtering.

**Server (`server.js`, single file).** Sections in order: middleware (request logging, static
files, CORS) → helpers (`wrap`, `sendError`, `renderHtmlPage`/`addAssetVersions`, `requireAdmin`,
`fetchCardData`) → card routes → card detail HTML route → bulk-data routes → admin/import routes →
error handler. Route order matters: `/cards/search` is registered before `/cards/:id` so the
literal path isn't swallowed by the param route.

**Frontend is server-templated, not a SPA.** `public/index.html` is served for both the search
page and every card detail page (`GET /card/:set/:collectorNumber/:slug`); the server injects
`CARD_DATA`/`PRINTS_DATA` JSON directly into the HTML via string replacement
(`renderHtmlPage(INDEX_HTML, [...])`) before sending it, rather than the client fetching card data
itself. `public/app.js` (search UI), `public/card.js` (card detail rendering), `public/list.js`
(the persistent card-list sidebar), and `public/autocomplete.js` are all plain scripts loaded via
`<script>` tags in a fixed order — no module bundler.

**Cache-busting.** `addAssetVersions()` rewrites local `.css`/`.js` `href`/`src` references in
served HTML to append `?v=<mtime>`, based on each file's on-disk modification time. This runs on
every HTML response (index, card detail, admin), so editing a public asset is enough to bust
client caches — no manual versioning needed.

**Search matching (`/cards/search`).** Query parsing is simplistic pattern matching, not a real
query grammar: it extracts `name:"..."` or `name:foo`, otherwise treats the whole query as a name
substring (`LIKE %term%`). Exact-name matches (and heuristic "name + trailing set code" or "name +
trailing collector number") short-circuit into a `redirect` response pointing at the card detail
page instead of returning a result list — the frontend is expected to follow `object: "redirect"`.
Results are grouped by card name, with all printings of a name attached to one representative
card's `prints` array.

**Admin import is stateful and single-flight**, held in the module-level `importJob` variable
(not persisted — a server restart loses in-progress job state, though the DB writes it already
made survive). `POST /admin/import` no-ops if a job is already running rather than queuing another.

**Deployment.** `.github/workflows/build-and-push.yml` builds the Docker image and pushes to
`ghcr.io/<repo>/surveilfall` on every push to `master` (tagged `latest` and the commit SHA) — there
is no separate CI test/lint gate before that push.
