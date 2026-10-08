import { safeCall } from '../shared/safe-call';

import type { ApiError } from './errors';
import type { Hooks, ResolvedRequestConfig, ResponseMeta } from './types';

export function runOnRequest(
  hooks: Hooks | undefined,
  config: ResolvedRequestConfig,
): ResolvedRequestConfig {
  if (!hooks?.onRequest) return config;
  return safeCall(() => hooks.onRequest!(config)) ?? config;
}

export function runOnBeforeSend(hooks: Hooks | undefined, config: ResolvedRequestConfig): void {
  if (!hooks?.onBeforeSend) return;
  safeCall(() => hooks.onBeforeSend!(config));
}

export function runOnResponse(
  hooks: Hooks | undefined,
  config: ResolvedRequestConfig,
  meta: ResponseMeta,
): void {
  if (!hooks?.onResponse) return;
  safeCall(() => hooks.onResponse!(config, meta));
}

export function runOnError(
  hooks: Hooks | undefined,
  config: ResolvedRequestConfig,
  error: ApiError,
): void {
  if (!hooks?.onError) return;
  safeCall(() => hooks.onError!(config, error));
}

export function runOnRetry(
  hooks: Hooks | undefined,
  config: ResolvedRequestConfig,
  attempt: number,
  error: ApiError,
): ResolvedRequestConfig {
  if (!hooks?.onRetry) return config;
  return safeCall(() => hooks.onRetry!(config, attempt, error)) ?? config;
}
