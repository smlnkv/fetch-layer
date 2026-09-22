import { safeCall } from '../shared/safe-call';

import type { ApiError } from './errors';
import type { Hooks, RequestConfig, ResponseMeta } from './types';

export function runOnRequest(hooks: Hooks | undefined, config: RequestConfig): RequestConfig {
  if (!hooks?.onRequest) return config;
  return safeCall(() => hooks.onRequest!(config)) ?? config;
}

export function runOnBeforeSend(hooks: Hooks | undefined, config: RequestConfig): void {
  if (!hooks?.onBeforeSend) return;
  safeCall(() => hooks.onBeforeSend!(config));
}

export function runOnResponse(
  hooks: Hooks | undefined,
  config: RequestConfig,
  meta: ResponseMeta,
): void {
  if (!hooks?.onResponse) return;
  safeCall(() => hooks.onResponse!(config, meta));
}

export function runOnError(hooks: Hooks | undefined, config: RequestConfig, error: ApiError): void {
  if (!hooks?.onError) return;
  safeCall(() => hooks.onError!(config, error));
}

export function runOnRetry(
  hooks: Hooks | undefined,
  config: RequestConfig,
  attempt: number,
  error: ApiError,
): RequestConfig {
  if (!hooks?.onRetry) return config;
  return safeCall(() => hooks.onRetry!(config, attempt, error)) ?? config;
}
