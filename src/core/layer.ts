import type { Client, RequestFn } from './types';

/**
 * Context that createClient passes to every layer when building the
 * pipeline. Shared by all client layers.
 */
export interface LayerContext {
  readonly warn?: (message: string) => void;
}

/**
 * fn is the request function produced by this layer. state - a value
 * the layer saves until attach: this is how a layer ties its state
 * to a specific client, even if the same Layer is used across
 * several clients.
 */
export interface LayerWrapResult {
  fn: RequestFn;
  state?: unknown;
}

/**
 * Layer. Passed to ClientOptions.layers from the outside in: the
 * first in the array wraps all subsequent layers, the last receives
 * the base transport.
 */
export interface Layer {
  /**
   * Name used in validation error messages. Must be unique: a
   * duplicate fails client creation. For built-ins it matches the
   * factory name.
   */
  readonly name: string;

  /**
   * Priority: higher means further outside. Layers must go in
   * descending stage order. If omitted, the layer skips order
   * validation. Built-ins: withIdempotency: 3, withRetry: 2,
   * withAuth: 1. To insert between built-ins: 2.5 - between
   * withIdempotency and withRetry, 1.5 - between withRetry
   * and withAuth.
   */
  readonly stage?: number;

  /**
   * Wraps the next function in the pipeline. Called from the inside
   * out: the last layer in the array receives the base transport.
   * state is passed back to the same layer's attach.
   */
  wrap(next: RequestFn, context: LayerContext): LayerWrapResult;

  /**
   * Called after client creation. For service functions that need
   * the client itself (resetRefreshCircuit). state is what wrap
   * returned for this client. An exception aborts createClient;
   * the message includes the layer name.
   */
  attach?(client: Client, state: unknown): void;
}

/**
 * Layers without stage are skipped.
 *
 * Checks name uniqueness, descending stage, and no duplicate stages:
 * with equal stage the order would be determined by position in the
 * array, which is implicit.
 *
 * @internal
 */
export function validateLayerOrder(layers: readonly Layer[]): void {
  const seenNames = new Set<string>();
  const seenStages = new Map<number, string>();
  let prevStage = Infinity;
  let prevName: string | undefined;

  for (const layer of layers) {
    if (seenNames.has(layer.name)) {
      throw new Error(
        `createClient: layer "${layer.name}" is passed more than once. ` +
          `Each layer must have a unique name.`,
      );
    }
    seenNames.add(layer.name);

    if (layer.stage === undefined) continue;

    if (!Number.isFinite(layer.stage)) {
      throw new Error(
        `createClient: layer "${layer.name}" has invalid stage ${String(layer.stage)}. ` +
          `Stage must be a finite number.`,
      );
    }

    if (layer.stage > prevStage) {
      throw new Error(
        `createClient: layer "${layer.name}" (stage ${layer.stage}) breaks the order ` +
          `after "${prevName}" (stage ${prevStage}). ` +
          `Expected descending stage. Built-in stages: withIdempotency=3, ` +
          `withRetry=2, withAuth=1. ` +
          `For a custom layer between withIdempotency and withRetry use stage 2.5, ` +
          `between withRetry and withAuth use stage 1.5.`,
      );
    }

    const stageOwner = seenStages.get(layer.stage);
    if (stageOwner !== undefined) {
      throw new Error(
        `createClient: layers "${stageOwner}" and "${layer.name}" have the same stage ` +
          `${layer.stage}. Order between them would be determined by position in the ` +
          `layers array, which is ambiguous. Use fractional stages (for example 2.5) ` +
          `to make the order explicit.`,
      );
    }

    seenStages.set(layer.stage, layer.name);

    prevStage = layer.stage;
    prevName = layer.name;
  }
}

/**
 * Applies layers from the inside out. state[i] corresponds to
 * layers[i].
 *
 * @internal
 */
export function applyLayers(
  base: RequestFn,
  layers: readonly Layer[],
  context: LayerContext,
): { pipeline: RequestFn; states: unknown[] } {
  const states: unknown[] = new Array(layers.length);
  let pipeline = base;

  for (let i = layers.length - 1; i >= 0; i--) {
    const result = layers[i]!.wrap(pipeline, context);
    pipeline = result.fn;
    states[i] = result.state;
  }

  return { pipeline, states };
}

/**
 * Call order matches array order, state comes from the same
 * position. If attach throws, createClient aborts; the error
 * includes the layer name.
 *
 * @internal
 */
export function runAttach(
  layers: readonly Layer[],
  states: readonly unknown[],
  client: Client,
): void {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    try {
      layer.attach?.(client, states[i]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`createClient: layer "${layer.name}" attach threw: ${message}`, {
        cause: e,
      });
    }
  }
}
