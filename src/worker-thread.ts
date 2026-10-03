/**
 * The worker side of `defanged/worker`: one interpreter per thread, tools
 * and output hooks proxied to the host over messages. Loaded by worker.ts;
 * never imported directly.
 */

import { parentPort } from 'node:worker_threads';
import { collections } from './collections';
import { ErrorData, InterpreterError, errorFromData, errorToData } from './errors';
import { functools } from './functools';
import { Interpreter, InterpreterOptions } from './interpreter';
import { itertools } from './itertools';
import { json } from './json';
import { random } from './random';
import { string } from './string';
import { PyModule } from './values';

/** Messages from the host. */
export type HostMessage =
  | { type: 'init'; options: WorkerInit }
  | { type: 'run'; id: number; code: string }
  | { type: 'tool-result'; id: number; value?: unknown; error?: ErrorData | string };

/** Messages to the host. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-failed'; message: string }
  | { type: 'done'; id: number; value: unknown }
  | { type: 'fail'; id: number; error: ErrorData | string }
  | { type: 'tool-call'; id: number; name: string; args: unknown[]; kwargs: Record<string, unknown> }
  | { type: 'print'; text: string }
  | { type: 'chart'; options: unknown }
  | { type: 'table'; options: unknown };

export interface WorkerInit {
  tools: string[];
  modules: string[];
  hooks: { print: boolean; chart: boolean; table: boolean };
  maxIterations?: number;
  timeoutMs?: number;
  limits?: InterpreterOptions['limits'];
  timezone?: string;
}

const MODULES: Record<string, PyModule> = { json, itertools, collections, functools, string, random };

const port = parentPort!;
const send = (message: WorkerMessage): void => port.postMessage(message);

let interpreter: Interpreter | null = null;
let nextCall = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function callHost(name: string, args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCall++;
    pending.set(id, { resolve, reject });
    send({ type: 'tool-call', id, name, args, kwargs });
  });
}

function init(options: WorkerInit): void {
  const modules = options.modules.map((name) => {
    const m = MODULES[name];
    if (!m) throw new Error(`Module '${name}' is not available in worker mode`);
    return m;
  });
  interpreter = new Interpreter({
    maxIterations: options.maxIterations,
    timeoutMs: options.timeoutMs,
    limits: options.limits,
    timezone: options.timezone,
    modules,
    // The legacy convention hands keywords over as a trailing object, which
    // is exactly the shape the host needs to resolve the real signature.
    tools: options.tools.map((name) => ({
      name,
      handler: (...args: unknown[]) => callHost(name, args.slice(0, -1), args[args.length - 1] as Record<string, unknown>),
    })),
    onPrint: options.hooks.print ? (text) => send({ type: 'print', text }) : undefined,
    onChart: options.hooks.chart ? (o) => send({ type: 'chart', options: o }) : undefined,
    onTable: options.hooks.table ? (o) => send({ type: 'table', options: o }) : undefined,
  });
}

// Nothing may escape this handler: an uncaught error in a worker thread is
// the host's problem to report, not a crash.
port.on('message', async (message: HostMessage) => {
  if (message.type === 'init') {
    try {
      init(message.options);
      send({ type: 'ready' });
    } catch (e) {
      send({ type: 'init-failed', message: e instanceof Error ? e.message : String(e) });
    }
  } else if (message.type === 'tool-result') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error === undefined) waiter.resolve(message.value);
    else waiter.reject(typeof message.error === 'string' ? new Error(message.error) : errorFromData(message.error));
  } else if (message.type === 'run') {
    try {
      send({ type: 'done', id: message.id, value: await interpreter!.run(message.code) });
    } catch (e) {
      send({ type: 'fail', id: message.id, error: e instanceof InterpreterError ? errorToData(e) : String(e instanceof Error ? e.message : e) });
    }
  }
});
