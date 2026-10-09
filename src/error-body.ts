/**
 * Подпуть fetch-layer/error-body: встроенные парсеры тела ошибки
 * и публичные типы для написания своего парсера.
 *
 * Плоский формат { code, message, fields, requestId } встроен
 * в ядро как дефолт. Остальные форматы вынесены сюда: их
 * подключают только те, кому они нужны.
 */

export { errorBodyParsers } from './core/error-body-parsers';

export type { ErrorBodyParser, ParsedErrorBody } from './core/error-body';
