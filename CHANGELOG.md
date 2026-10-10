# Changelog

## 1.0.0

- Layer pipeline: idempotency → retry → auth.
- `withAuth`: single-flight refresh, circuit breaker, cooldown, `resetRefreshCircuit`.
- `withIdempotency`: one key per operation, `IdempotencySource`, sources for `sessionStorage`, `localStorage`, memory.
- `withRetry`: exponential backoff with jitter, `Retry-After` support.
- Unified `ApiError` with `kind`, `code`, and getters.
- Error body parsers: flat in core, `content`/`error`/`rfc7807` in `fetch-layer/error-body`.
- Transport: JSON, `FormData`, `Blob`, `File`, `ArrayBuffer`, `TypedArray`, `URLSearchParams`, `ReadableStream`, Node.js `Readable`.
- Cross-realm type detection, recursive rejection of non-serializable bodies.
