# PlayReview AI — Backend

A TypeScript Express API that scrapes public Google Play data, computes review
analytics, and generates Excel exports. No database — results are held in an
in-memory TTL cache keyed by package name.

## Scripts

```bash
npm run dev        # tsx watch, hot-reloads on change
npm run build      # compile to dist/
npm start          # run compiled dist/index.js
npm run typecheck  # tsc --noEmit
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS allow-origin |
| `CACHE_TTL_MINUTES` | `30` | How long a fetched result stays cached |
| `MAX_REVIEWS` | `2000` | Upper bound on reviews fetched per app |

## API

### `GET /api/reviews/stream?url=<playStoreUrl>`
Server-Sent Events. Emits `stage` events (`connecting` → `app-details` →
`downloading-reviews` with a live count → `analytics` → `preparing`), then a
`complete` event, or a `fetch-error` event `{ code, message, suggestion }`.
On completion the full result is cached and retrievable via the endpoint below.

### `GET /api/reviews/:packageName`
Returns the cached `{ app, reviews, analytics, fetchedAt }` payload, or `404`
with `code: "NOT_CACHED"` if the entry is missing or expired.

### `POST /api/reviews`
Body `{ "url": "..." }`. Synchronous (non-SSE) equivalent of the stream — fetches,
caches, and returns the full payload in one response.

### `POST /api/export/excel`
Body `{ "packageName": "..." }`. Streams a `.xlsx` (Reviews + Summary sheets)
built from the cached dataset with ExcelJS.

### `GET /api/health`
Liveness probe.

## Structure

```
src/
  config/       env loading
  routes/       express routers
  controllers/  request handlers (SSE orchestration, export)
  services/     playScraper · analytics · cache · export/excel
  middleware/   error handler, body validation (zod)
  utils/        URL parsing, SSE channel, language detection, errors, stopwords
  types/        shared app & review types
```

## Notes

- **Language detection** uses `franc-min`; short/ambiguous reviews fall back to
  the locale the reviews were fetched in to avoid noisy misclassification.
- `google-play-scraper`'s TypeScript types mistype the `sort` enum, so the newest
  sort is passed as its literal value (`2`) — see `services/playScraper.service.ts`.
