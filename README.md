# fetch-layers

**English** | [Русский](./README.ru.md)

An HTTP client built from layers. Each layer handles a single concern: auth, retries, idempotency. Layers are added as needed, and the order is validated at client creation.

Three built-in layers:

- `withAuth` - token refresh on 401, one refresh for all concurrent requests
- `withRetry` - retries 5xx and network errors, honors `Retry-After`
- `withIdempotency` - one `Idempotency-Key` per operation, including retries

Errors from layers and transport come back as `ApiError`. Zero dependencies, tree-shaking.

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

- **SPA with auth.** Several requests go out at once, all get 401. `withAuth` runs a single refresh for all of them and resends each request with the new token.

- **API with mutations.** Orders, payments, bookings. You need to retry 5xx and timeouts, but a retried POST /orders creates a second order. `withIdempotency` generates a key once and keeps it until the server confirms.

- **Several APIs in one app.** Public and private, different tokens, different error shapes. Each API gets its own client with its own layers and its own `SessionProvider`.

## Problems it solves

### Session expired, requests fail with 401

Five requests go out at once, all get 401. Without coordination each request starts its own refresh - five refresh calls instead of one. The token is written to storage five times in a race: the last one wins, but some requests keep the old token and get 401 again.

`withAuth` collects every waiting request into a single refresh. While it runs, the rest wait. Once the token is fresh, each request is sent again with the new header. One refresh instead of five.

### Retries and duplicates

Network errors and 5xx: server may be down, connection may drop. A retry often succeeds on the second or third attempt.

A retry creates duplicates when the operation is not idempotent. POST /orders on retry creates two orders: the first one may have reached the server, the response was lost, the retry created another.

The fix is `Idempotency-Key`. The server matches it against previous requests and returns the result of the first one. The catch: the key must stay the same across the whole logical operation, including all retries and any refresh in between.

`withIdempotency` generates the key once, before the first attempt, and keeps it until the server confirms. Even if the request failed on the network and replays five minutes later from somewhere else - same key.

### Different error shapes

Every backend has its own error format. One returns `{ code, message }`, another `{ error: { code } }`, a third RFC 7807. Without a common mechanism, the parsing has to be repeated everywhere an error is handled.

The library splits error fields into two layers. The structural layer is the same for every backend: `kind`, `status`, `isRetryable`, `isCancelled`, `isUncertain`, `requestId` (from the `X-Request-Id` header), `retryAfterMs`. The content layer comes from the response body: `code`, `message`, `fields`, `details`. By default the client understands the flat shape `{ code, message, fields }` and plain text. For other formats (Fastify, RFC 7807, DRF, Laravel, `{ error: { code } }`) the app passes its own parsing function via `parseErrorBody`.

The full response body is always available in `err.rawBody`, even when the format isn't recognized.

### Token refresh temporarily unavailable

Token refresh may fail: network is down, refresh endpoint returns 5xx. Without protection every new 401 starts another refresh attempt, and this adds load on the server.

`withAuth` blocks refresh for a while after a failure. While the block is active, 401s are returned to the app without an attempt to refresh. `onCircuitOpen` and `onCircuitClose` report when the breaker opens or closes.

## Features

- **Auth.** `withAuth` works with any `SessionProvider`. To wire the layer up, implement three methods: `getAuthHeaders`, `refresh`, `clear`. Three refresh states (`success`, `definitely-failed`, `temporarily-failed`) give the app control: log the user out or retry later. Circuit breaker settings: `circuitBreakerMs` and `refreshTimeoutMs`. The breaker opens only on network errors, timeouts and 5xx, not on errors in `refresh`. The `resetRefreshCircuit(client)` function resets it manually when the app knows the problem is gone.

- **Idempotency.** `withIdempotency` adds an `Idempotency-Key` header to every mutating method (POST, PUT, PATCH, DELETE). For endpoints that do not accept the header, pass `skipIdempotency: true` on the request. The key can live in `localStorage`, `sessionStorage` or memory - depending on whether you need it to survive a reload. For custom storage there is the `IdempotencySource` interface (two methods) and the `stableSerialize` helper for the body hash. `maxEntries` limits the store size, eviction by last use time.

- **Retries.** `withRetry` is configurable: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitterRatio`, `retryOnNetwork`, `retryOnTimeout`. Custom policies via `shouldRetry`, `computeDelay`, `onBeforeRetry`. `Retry-After` from the server takes priority over the computed delay.

- **Errors.** `ApiError` with getters `isRetryable`, `isCancelled`, `isAuthError`, `isUncertain` and others. `err.fields` is a ready-to-use `Record<string, string>` for forms, when the server returns the flat shape. `err.rawBody` - the original response body for everything else. Custom parsing via `parseErrorBody`.

- **Transport.** Validates `baseUrl`, `timeoutMs`, `fetch` and layer order at client creation. Headers accept `Record`, `Headers` or an array of pairs. `defaultHeaders` for common headers. `timeoutMs` and `signal` in a specific request. `requestWithMeta` returns HTTP metadata together with data - for cases when a response header affects the next step: `Retry-After` in `202 Accepted`, `Location` in `201`, `X-Request-Id` for logs. `fetchOptions` for other `fetch` params.

  For async operations the server may answer `202 Accepted` with a `Retry-After` header. The pause value in milliseconds is available in `meta.retryAfterMs` - exactly as the server sent it. The library does not cap the value: the app decides how long to wait.

  ```ts
  const { meta } = await client.requestWithMeta({
    path: '/api/jobs',
    method: 'POST',
    body: { action: 'start' },
  });
  await new Promise((resolve) => setTimeout(resolve, meta.retryAfterMs ?? 1000));
  ```

- **Request bodies.** JSON, `FormData`, `Blob`, `File`, `ArrayBuffer`, `TypedArray`, `DataView`, `URLSearchParams`, `ReadableStream`, Node.js `stream.Readable`. Works with types from iframes and Workers. Recursive check: nested non-serializable values are rejected before the request is sent with `BODY_SERIALIZATION_ERROR`.

- **Layers.** A custom layer is an object with four fields: `name`, `stage`, `wrap`, `attach`. `LayerContext` exposes `warn`. Priorities `2.5` and `1.5` for inserting between built-in layers.

## Install and first request

```
npm install fetch-layers
```

```ts
import { createClient } from 'fetch-layers';

const client = createClient({ baseUrl: '/api' });

const products = await client.get<Product[]>('/products');

const review = await client.post('/reviews', {
  productId: products[0].id,
  rating: 5,
  comment: 'Great product',
});
```

Both methods return the parsed response body. `post` sends an object as JSON. Any error comes back as `ApiError` - catch it with `try/catch` or `.catch()`.

### Wiring up layers

The `layers` option takes an array of layers, ordered from outermost to innermost:

```ts
import { createClient } from 'fetch-layers';
import {
  withAuth,
  withRetry,
  withIdempotency,
  sessionStorageSource,
} from 'fetch-layers/layers';

const client = createClient({
  baseUrl: '/api',
  layers: [
    withIdempotency(sessionStorageSource()),
    withRetry({ maxAttempts: 3 }),
    withAuth({ provider: sessionProvider }),
  ],
});
```

What the layers do, in this order:

- `withIdempotency` wraps everything else. The key is generated once per operation and stays put across retries.
- `withRetry` retries on 5xx, network errors and timeouts, without changing the key.
- `withAuth` adds auth headers and refreshes the token on 401.

The order is not arbitrary - the library validates it at client creation. Swap `withIdempotency` and `withRetry` and the key gets regenerated on every retry - that breaks deduplication. `createClient` throws with the name of the layer that breaks the rule.

If you don't need layers, `createClient({ baseUrl: '/api' })` gives you a plain HTTP client without auth, retries or idempotency.

## Requirements

Runs on Node.js 20.6+, modern browsers, Deno and Bun.

Needs a global `fetch`. If it's missing, `createClient` throws.

ESM only. CommonJS is not supported.

`crypto.randomUUID` is only needed when `withIdempotency` is in use with the built-in key generator. It is checked on the first mutating request.

## Modules

The library is split into modules. Bundle size depends on what you import.

| Module                    | What it exports                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fetch-layers`             | `createClient`, `ApiError`, `toApiError`, `ErrorBodyParser`, storages and public types                    |
| `fetch-layers/layers`      | Factories for all built-in layers and idempotency key sources                                             |
| `fetch-layers/auth`        | Types `SessionProvider`, `RefreshResult`, `SessionExpiredReason`, `resetRefreshCircuit`                   |
| `fetch-layers/idempotency` | `IdempotencySource`, `IdempotencyContext`, `IdempotencyOutcome`, `createSessionSource`, `stableSerialize` |
| `fetch-layers/retry`       | Only `withRetry` and its options                                                                          |
| `fetch-layers/storage`     | `StorageLike`, `createMemoryStorage`, `fromWebStorage`                                                    |

### Direct imports for a smaller bundle

`fetch-layers/layers` re-exports all three layers. If you only use one, import it directly - the bundler won't pull the others in.

```ts
import { withRetry } from 'fetch-layers/retry';
import { withAuth } from 'fetch-layers/auth';
import { withIdempotency, sessionStorageSource } from 'fetch-layers/idempotency';
```

`fetch-layers/layers` remains convenient for the common case: one import instead of three.

## How layers work

Every layer is a wrapper around a request function. The `wrap` method takes `next` and returns its own version. The library follows the Decorator pattern (GoF): it adds behavior while keeping the interface. The first layer in the array sees the request first, the last sees it last. Built-in layers run in order: idempotency, retries, auth. The transport receives the request last.

Each layer has a priority (`stage`). Higher number - earlier in the chain. Built-in priorities: `withIdempotency: 3`, `withRetry: 2`, `withAuth: 1`. To insert a custom layer between built-ins, use fractional values: `2.5` goes between idempotency and retries, `1.5` between retries and auth.

Layers without `stage` skip the order check. They can go anywhere in the array.

The order is not arbitrary. The idempotency key must be generated before the first attempt, otherwise every retry creates a new key and deduplication stops working. Auth must sit after retries, so a 401 goes to the auth layer, not to retry. `createClient` validates the order and throws with the name of the layer that breaks the rule.

Each client has its own state. The same `Layer` object can be passed to two `createClient` calls: each gets its own `RefreshManager`, its own warnings, its own counter. One client's state does not affect the other.

### Why layered architecture instead of hooks or interceptors

A layer controls the call: it can call `next` several times, catch an error and call again with different data, run code before and after. A callback can't do this: it receives data and returns it back. It does not decide when and how many times to call the next step.

A hook in ky or ofetch, an interceptor in axios - these are callbacks invoked at a fixed point: before the request or after the response. Each gets data and returns it.

`withRetry` calls `next` in a loop until it gets a successful response. `withAuth` catches 401, does a refresh separately, then calls `next` with a new token. `withIdempotency` wraps the whole call and clears the key only after the server confirms.

Hooks and interceptors can only change data on the way in and out. They don't describe the loop or the order of calls.

## Working with TanStack Query

fetch-layers plugs into `queryFn` and `mutationFn`.

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const client = createClient({
  baseUrl: '/api',
  layers: [
    withIdempotency(sessionStorageSource()),
    withAuth({ provider: sessionProvider }),
  ],
});

function useUser(id: string) {
  return useQuery({
    queryKey: ['user', id],
    queryFn: ({ signal }) => client.get<User>(`/users/${id}`, { signal }),
  });
}

function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (order: Order) => client.post<Order>('/orders', order),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
```

`queryFn` gets `signal` from TanStack Query, fetch-layers accepts it and combines with its own timeout. Cancellation works both ways.

The main conflict is retry. TanStack Query has its own retry for `useQuery`, fetch-layers has its own for HTTP. If both are enabled, 3 attempts x 3 attempts = 9 requests. Keep retry in one place:

```ts
// Retry in fetch-layers, TanStack Query without retry.
const client = createClient({
  baseUrl: '/api',
  layers: [withRetry({ maxAttempts: 3 })],
});

useQuery({
  queryKey: ['user', id],
  queryFn: () => client.get<User>(`/users/${id}`),
  retry: false,
});
```

Everything else works without adapters: `ApiError` propagates to `error`, `signal` is accepted as-is, DevTools shows `queryFn` calls unchanged.

## License

MIT. See [LICENSE](./LICENSE).

Changelog: [CHANGELOG.md](./CHANGELOG.md).
