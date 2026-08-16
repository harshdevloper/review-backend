# PlayReview AI — Backend

A TypeScript Express API that collects public Google Play data, computes review
analytics, and generates Excel exports. Results are cached on disk and can also
be persisted in Postgres.

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
| `DISK_CACHE_TTL_MINUTES` | `10080` | How long disk-cached results remain reusable |
| `MAX_REVIEWS` | `0` | Latest-review cap; `0` walks every available page |
| `FETCH_TIMEOUT_MINUTES` | `0` | Optional partial-fetch safety limit; `0` has no timeout |
| `DATABASE_URL` | empty | Optional Postgres persistence for incremental refreshes |

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
- Review collection walks Google's chronological `NEWEST` cursor to exhaustion,
  deduplicates by review id, and retries transient page failures. If an optional
  cap or timeout stops the walk, the result is marked partial and backfilled on
  the next fetch instead of being treated as complete.
- Storefront-restricted apps are retried across common markets. For example,
  `com.fatakpay` resolves through the Indian storefront when the default US
  listing returns 404.
- `google-play-scraper`'s TypeScript types mistype the `sort` enum, so the newest
  sort is passed as its literal value (`2`) — see `services/playScraper.service.ts`.
