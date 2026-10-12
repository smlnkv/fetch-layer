# Changelog

## 1.0.0

- Layer pipeline: idempotency -> retry -> auth.
- `withAuth`: single-flight refresh, circuit breaker, cooldown, `resetRefreshCircuit`.
- `withIdempotency`: one key per operation, `IdempotencySource`, sources for `sessionStorage`, `localStorage`, memory.
- `withRetry`: exponential backoff with jitter, `Retry-After` support.
- `ApiError` with structural fields, content fields from the response body, and getters.
- Error body: flat parser as default, `ErrorBodyParser` as extension point for custom formats.
- Transport: JSON, `FormData`, `Blob`, `File`, `ArrayBuffer`, `TypedArray`, `URLSearchParams`, `ReadableStream`, Node.js `Readable`.
- Cross-realm type detection, recursive rejection of non-serializable bodies.
