# fetch-layer

**English** | [Русский](./README.ru.md)

HTTP client built from layers. Each layer handles a single concern: auth, retries, idempotency. Layers are optional; their order is validated at client creation.

Three built-in layers plus a unified `ApiError`:

- `withAuth` — token refresh on 401, single refresh shared by concurrent requests, circuit breaker when refresh is unreachable
- `withRetry` — retries 5xx and network errors, honours `Retry-After`
- `withIdempotency` — one `Idempotency-Key` per operation, preserved across retries
- `ApiError` — unified error shape with ready `code`, `fields`, `requestId`

Zero dependencies, tree-shaking.

## Contents

- [Who it's for](#who-its-for)
- [Problems it solves](#problems-it-solves)
- [Features](#features)
- [Install and first request](#install-and-first-request)
- [Requirements](#requirements)
- [Modules](#modules)
- [How layers work](#how-layers-work)
- [Working with TanStack Query](#working-with-tanstack-query)

## Who it's for

- **SPA with auth.** Five requests go out at once, all get 401. Without coordination each one starts its own refresh: five parallel refresh requests, a race condition when writing to storage, only one token survives. Some requests leave with a stale token and get 401 again. `withAuth` collects every waiting request into a single refresh. While it runs, the rest wait. Once the token is fresh, each request is sent again with the new header. One refresh instead of five.

- **API with mutations.** Orders, payments, bookings. You want to retry 5xx and timeouts, but POST /orders on retry creates two orders. `withIdempotency` generates a key once and keeps it until the server confirms.

- **Several APIs in one app.** Public and private, different tokens, different error shapes. Each API gets its own client with its own layers and its own `SessionProvider`.

## Problems it solves

### Session expired, requests fail with 401

Five requests go out at once, all get 401. Without coordination each one starts its own refresh. Five parallel refresh requests, a race condition when writing to storage, only one token survives. Some requests leave with a stale token and get 401 again.

`withAuth` collects every waiting request into a single refresh. While it runs, the rest wait. Once the token is fresh, each request is sent again with the new header. One refresh instead of five.

### Retries and duplicates

Network errors and 5xx: server may be down, connection may drop. A retry often succeeds after the second or third attempt.

Retry creates duplicates when the operation is not idempotent. POST /orders on retry creates two orders: the first one may have reached the server, the response got lost, the retry created another.

The fix is `Idempotency-Key`. The server matches it against previous requests and returns the result of the first one. The catch: the key must stay the same across the whole logical operation, including all retries and refresh in between.

`withIdempotency` generates the key once, before the first attempt, and keeps it until the server confirms. Even if the request failed on the network and replays five minutes later from somewhere else — same key.

### Different error shapes

Every backend has its own error format. One returns `{ code, message }`, another `{ error: { code } }`, a third RFC 7807. The parsing is repeated in every place an error is handled, and ends up scattered across the app.

The library normalizes every error to `ApiError`. Fields are the same regardless of what the server returned: `code`, `message`, `fields`, `requestId`, `isRetryable`, `isCancelled`.

### Token refresh temporarily unavailable

Token refresh may fail: network is down, refresh endpoint returns 5xx. Without protection every new 401 starts another refresh attempt, adding more load on the server.

`withAuth` blocks refresh for a while after a failure. While the block is active, 401s are returned to the app without an attempt to refresh. `onCircuitOpen` and `onCircuitClose` report the state change.

## Features

- **Auth.** `withAuth` works with any `SessionProvider` — three methods: `getAuthHeaders`, `refresh`, `clear`. Three refresh states (`success`, `definitely-failed`, `temporarily-failed`) give the app control: log the user out or retry later. Circuit breaker with configurable `circuitBreakerMs` and `refreshTimeoutMs`. `resetRefreshCircuit` for a manual reset.

- **Idempotency.** `withIdempotency` stores the key in `sessionStorage`, `localStorage` or memory. Custom storage goes through `IdempotencySource` — two methods — plus `stableSerialize` for the body hash. `maxEntries` limits the store size, oldest entries are removed first.

- **Retries.** `withRetry` is configurable: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitterRatio`, `retryOnNetwork`, `retryOnTimeout`. Custom policies via `shouldRetry`, `computeDelay`, `onBeforeRetry`. `Retry-After` from the server takes priority over the computed delay.

- **Errors.** One `ApiError` with getters `isRetryable`, `isCancelled`, `isAuthError`, `isUncertain` and others. `err.fields` is a ready-to-use `Record<string, string>` for forms. Three built-in parsers in `fetch-layer/error-body` for `content`, `error`, RFC 7807. Custom parser via `parseErrorBody`.

- **Transport.** Validates `baseUrl`, `timeoutMs`, `fetch` and layer order at client creation. Headers accept `Record`, `Headers` or an array of pairs. `defaultHeaders` for common headers. Per-request `timeoutMs` and `signal`. `requestWithMeta` for HTTP metadata. `fetchOptions` for other `fetch` params.

- **Request bodies.** JSON, `FormData`, `Blob`, `File`, `ArrayBuffer`, `TypedArray`, `DataView`, `URLSearchParams`, `ReadableStream`, Node.js `stream.Readable`. Works with types from iframes and Workers. Recursive check: nested non-serializable values are rejected before the request is sent with `BODY_SERIALIZATION_ERROR`.

- **Layers.** Custom layer is an object with four fields: `name`, `stage`, `wrap`, `attach`. `LayerContext` exposes `warn`. Priorities `2.5` and `1.5` for inserting between built-in layers.

## Install and first request

```
npm install fetch-layer
```

```ts
import { createClient } from "fetch-layer";

const client = createClient({ baseUrl: "/api" });

const products = await client.get<Product[]>("/products");

const review = await client.post("/reviews", {
  productId: products[0].id,
  rating: 5,
  comment: "Great product"
});
```

`get` returns the parsed body. `post` sends an object as JSON and returns the server response. Every error comes back as `ApiError` — catch it with `try/catch` or `.catch()`.

### Wiring up layers

Layers go into `layers`. The order in the array is outermost to innermost:

```ts
import { createClient } from "fetch-layer";
import {
  withAuth,
  withRetry,
  withIdempotency,
  sessionStorageSource
} from "fetch-layer/layers";

const client = createClient({
  baseUrl: "/api",
  layers: [
    withIdempotency({ source: sessionStorageSource() }),
    withRetry({ maxAttempts: 3 }),
    withAuth({ provider: sessionProvider })
  ]
});
```

What's happening:

- `withIdempotency` wraps everything else. The key is generated once per operation and stays put across retries.
- `withRetry` retries on 5xx, network errors and timeouts, without changing the key.
- `withAuth` adds auth headers and refreshes the token on 401.

The order is not arbitrary: the library validates it at client creation. Swap `withIdempotency` and `withRetry` and the key gets regenerated on every retry — that stops deduplication from working. `createClient` throws with the name of the offending layer.

If layers are not needed, `createClient({ baseUrl: "/api" })` gives a plain HTTP client without auth, retries or idempotency.

## Requirements

Runs on Node.js 20.6+, modern browsers, Deno and Bun.

Needs a global `fetch`. If it's missing, `createClient` throws.

ESM only. CommonJS is not supported.

`crypto.randomUUID` is only needed when `withIdempotency` is in use with the built-in key generator. Checked on the first mutating request.

## Modules

The library is split into modules. Bundle size depends on what you import.

| Module                    | What it exports                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fetch-layer`             | `createClient`, `ApiError`, `toApiError`, storages and public types                                       |
| `fetch-layer/layers`      | Factories for all built-in layers and idempotency key sources                                             |
| `fetch-layer/auth`        | Types `SessionProvider`, `RefreshResult`, `SessionExpiredReason`, `resetRefreshCircuit`                  |
| `fetch-layer/idempotency` | `IdempotencySource`, `IdempotencyContext`, `IdempotencyOutcome`, `createSessionSource`, `stableSerialize` |
| `fetch-layer/retry`       | Only `withRetry` and its options                                                                          |
| `fetch-layer/storage`     | `StorageLike`, `createMemoryStorage`, `fromWebStorage`                                                    |
| `fetch-layer/error-body`  | Parsers `errorBodyParsers` and types `ErrorBodyParser`, `ParsedErrorBody`                                 |

### Direct imports for minimal bundle

`fetch-layer/layers` re-exports all three layers. If you only use one, import it directly — the bundler won't pull the others in.

```ts
import { withRetry } from "fetch-layer/retry";
import { withAuth } from "fetch-layer/auth";
import { withIdempotency, sessionStorageSource } from "fetch-layer/idempotency";
```

`fetch-layer/layers` stays convenient for the common case: one import instead of three.

## How layers work

Every layer is a wrapper around a request function. The `wrap` method takes `next` and returns its own version. This is the Decorator pattern (GoF): it adds behaviour while keeping the interface. The first layer in the array sees the request first, the last — last. Built-in layers run in order: idempotency, retries, auth, dispatch.

Each layer has a priority (`stage`). Higher number — earlier in the chain. Built-in priorities: `withIdempotency: 3`, `withRetry: 2`, `withAuth: 1`. To insert a custom layer between built-ins, use fractional values: `2.5` goes between idempotency and retries, `1.5` between retries and auth.

Layers without `stage` skip the order check. They can go anywhere in the array.

The order is not arbitrary. The idempotency key must be generated before the first attempt, otherwise every retry creates a new key and deduplication stops working. Auth must sit after retries, so a 401 goes to the auth layer, not to retry. `createClient` validates the order and throws with the layer name if it's wrong.

Each client has its own state. The same `Layer` object can be passed to two `createClient` calls: each gets its own `RefreshManager`, its own warnings, its own counter. They don't interfere.

### Why layered architecture instead of hooks and interceptors

A layer controls the call: it can call `next` several times, catch an error and call again with different data, run code before and after. A callback can't do this — it receives data and returns it back.

A hook in ky and ofetch, or an interceptor in axios, is a callback invoked at a fixed point: before the request or after the response. Each one gets data and returns it back.

`withRetry` calls `next` in a loop until it gets a successful response. `withAuth` catches 401, does a refresh separately, then calls `next` with a new token. `withIdempotency` wraps the whole call and clears the key only after the server confirms.

Hooks and interceptors only handle data before and after. They don't control the call.

## Working with TanStack Query

fetch-layer plugs into `queryFn` and `mutationFn`.

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const client = createClient({
  baseUrl: "/api",
  layers: [
    withIdempotency({ source: sessionStorageSource() }),
    withAuth({ provider: sessionProvider })
  ]
});

function useUser(id: string) {
  return useQuery({
    queryKey: ["user", id],
    queryFn: ({ signal }) => client.get<User>(`/users/${id}`, { signal })
  });
}

function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (order: Order) => client.post<Order>("/orders", order),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    }
  });
}
```

`queryFn` gets `signal` from TanStack Query, fetch-layer accepts it and combines with its own timeout. Cancellation works both ways.

The main conflict is retry. TanStack Query has its own retry for `useQuery`, fetch-layer has its own for HTTP. If both are enabled, 3 attempts x 3 attempts = 9 requests. Keep retry in one place:

```ts
// Retry in fetch-layer, TanStack Query without retry.
const client = createClient({
  baseUrl: "/api",
  layers: [withRetry({ maxAttempts: 3 })]
});

useQuery({
  queryKey: ["user", id],
  queryFn: () => client.get<User>(`/users/${id}`),
  retry: false
});
```

Everything else works out of the box: `ApiError` propagates to `error`, `signal` is accepted as-is, Devtools shows `queryFn` calls unchanged.

## License

MIT. See [LICENSE](./LICENSE).

Changelog: [CHANGELOG.md](./CHANGELOG.md).
