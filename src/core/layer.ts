import type { Client, Hooks, RequestFn } from './types';

/**
 * Логгер для внутренних сообщений. Все методы опциональны.
 *
 * Библиотека вызывает:
 * - warn - предупреждение о небезопасном повторе, стрим без skipRetry;
 * - info - успешный refresh токена, открытие и закрытие предохранителя;
 * - error - финальная ошибка запроса после всех повторов;
 * - debug - завершение запроса (успех или ошибка) с длительностью.
 *
 * Логгер не задан по умолчанию: библиотека не пишет в console
 * без явного запроса. Передайте свой logger в ClientOptions, чтобы
 * получать сообщения через него.
 */
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/**
 * Контекст, который createClient передаёт каждому слою при сборке
 * pipeline. Относится к клиенту в целом, а не к конкретному слою.
 */
export interface LayerContext {
  readonly hooks?: Hooks;
  readonly logger?: Logger;
}

/**
 * fn - обёрнутая функция запроса. state - произвольное значение,
 * которое слой сохраняет до вызова attach. Слой сам знает, что
 * положил, и сам проверяет state перед использованием.
 */
export interface LayerWrapResult {
  fn: RequestFn;
  state?: unknown;
}

/**
 * Слой клиента. Слои передаются в ClientOptions.layers в порядке
 * снаружи внутрь: первый в массиве оборачивает все последующие,
 * последний получает базовый транспорт.
 */
export interface Layer {
  /**
   * Используется в сообщениях об ошибках валидации порядка.
   * Для встроенных слоёв совпадает с именем фабрики (например,
   * withAuth).
   *
   * Имена должны быть уникальны: дубликат приводит к ошибке
   * при создании клиента.
   */
  readonly name: string;

  /**
   * Приоритет слоя: чем больше значение, тем снаружи слой. Слои
   * в ClientOptions.layers должны идти по убыванию stage.
   *
   * Если не задан, слой считается самым внутренним и не участвует
   * в проверке порядка. Встроенные значения: withIdempotency: 3,
   * withRetry: 2, withAuth: 1.
   *
   * Для кастомного слоя между встроенными используйте дробные
   * значения: 2.5 - между withIdempotency и withRetry,
   * 1.5 - между withRetry и withAuth.
   */
  readonly stage?: number;

  /**
   * Оборачивает следующую функцию в pipeline. Вызывается изнутри
   * наружу: последний слой в массиве получает базовый транспорт,
   * каждый предыдущий - результат следующего.
   *
   * Контекст (hooks, logger) собирается один раз и передаётся всем
   * слоям. state сохраняется рядом с pipeline и возвращается в attach
   * этого же слоя - так слой связывает своё состояние с конкретным
   * клиентом, даже если один и тот же Layer используется в нескольких
   * клиентах.
   */
  wrap(next: RequestFn, context: LayerContext): LayerWrapResult;

  /**
   * Вызывается после создания клиента. Для сервисных функций,
   * которым нужен сам клиент (например, resetRefreshCircuit).
   *
   * state - то, что этот же слой вернул из wrap для данного клиента.
   *
   * Исключение из attach прерывает createClient. Сообщение об
   * ошибке включает имя слоя.
   */
  attach?(client: Client, state: unknown): void;
}

/**
 * Слои без stage пропускаются: они не навязывают порядок и могут
 * стоять в любой позиции массива.
 *
 * Проверяет три вещи:
 * - уникальность имён слоёв: дубликат приводит к ошибке;
 * - убывание stage: слои идут снаружи внутрь;
 * - дубликаты stage: два слоя с одинаковым stage дают ошибку,
 *   потому что порядок между ними определяется позицией
 *   в массиве, а это неявно.
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
 * Применяет слои изнутри наружу: последний в массиве получает
 * базовую функцию, каждый предыдущий оборачивает результат
 * следующего. Возвращает pipeline и массив state, где state[i]
 * соответствует layers[i].
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
 * Порядок вызова совпадает с порядком в массиве. state берётся
 * из соответствующей позиции.
 *
 * Падение attach прерывает createClient. Ошибка включает имя слоя,
 * чтобы приложение знало, кто именно сломал создание клиента.
 * Оригинальное исключение доступно через cause.
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
