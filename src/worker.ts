/**
 * `defanged/worker`: the interpreter in its own thread, so the host can kill
 * a script that nothing else can stop (a blocking tool, a backtracking
 * regex) and so a script's memory is not the host's.
 *
 *   import { createWorkerInterpreter } from 'defanged/worker';
 *   const it = createWorkerInterpreter({ tools, timeoutMs: 1000 });
 *   await it.run(code);
 *   it.terminate();
 *
 * Tools and the print/chart/table hooks stay on the main thread and are
 * called over messages, so a handler may close over anything. What crosses
 * the boundary is structured-cloned: plain values, arrays, objects, Dates.
 */

import { Worker } from 'node:worker_threads';
import { CancelledError, InterpreterError, TimeoutError, errorFromData, errorToData } from './errors';
import { InterpreterOptions, RunOptions } from './interpreter';
import { NormalizedTool, normalizeTools, resolveArguments } from './tools';
import { PyModule } from './values';
import type { HostMessage, WorkerInit, WorkerMessage } from './worker-thread';

export interface WorkerInterpreterOptions extends Omit<InterpreterOptions, 'modules' | 'now'> {
  /** The optional modules by object (`[json, random]`) or by name. Only the
   *  modules shipped with defanged can be used in a worker. */
  modules?: (PyModule | string)[];
  /** Extra time the main thread allows past `timeoutMs` before it kills the
   *  worker, for a script the interpreter itself could not stop. Default 100. */
  killGraceMs?: number;
}

export interface WorkerInterpreter {
  /** Runs a script. Rejects with the same error classes `Interpreter.run` throws. */
  run(code: string, options?: RunOptions): Promise<any>;
  /** Stops the worker; resolves once the thread has exited. A run in
   *  progress rejects with CancelledError; the next run() starts a fresh
   *  worker, with fresh globals. */
  terminate(): Promise<void>;
}

type Settle = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class WorkerHost implements WorkerInterpreter {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tools: Map<string, NormalizedTool>;
  private readonly init: WorkerInit;
  private current: Settle | null = null;
  private nextRun = 1;

  constructor(private readonly options: WorkerInterpreterOptions) {
    const tools = normalizeTools(options.tools);
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.init = {
      tools: tools.map((t) => t.name),
      modules: (options.modules ?? []).map((m) => (typeof m === 'string' ? m : m.name)),
      hooks: { print: !!options.onPrint, chart: !!options.onChart, table: !!options.onTable },
      maxIterations: options.maxIterations,
      timeoutMs: options.timeoutMs,
      limits: options.limits,
      timezone: options.timezone,
    };
  }

  run(code: string, options: RunOptions = {}): Promise<any> {
    // One script at a time per worker, in call order.
    const turn = this.queue.then(() => this.runNow(code, options.signal ?? null));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  terminate(): Promise<void> {
    return this.kill(new CancelledError('worker terminated'));
  }

  private async runNow(code: string, signal: AbortSignal | null): Promise<unknown> {
    if (signal !== null && signal.aborted) throw new CancelledError(signal.reason);
    await this.start();
    const worker = this.worker!;
    const id = this.nextRun++;
    const { timeoutMs } = this.options;
    const hasDeadline = timeoutMs !== undefined && Number.isFinite(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.current = { resolve, reject };
        if (hasDeadline) {
          // The interpreter stops itself at the deadline when it can; the
          // kill is for the cases where it cannot.
          timer = setTimeout(() => void this.kill(new TimeoutError(timeoutMs)), timeoutMs + (this.options.killGraceMs ?? 100));
        }
        if (signal !== null) {
          onAbort = () => void this.kill(new CancelledError(signal.reason));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        this.post(worker, { type: 'run', id, code });
      });
    } finally {
      this.current = null;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal!.removeEventListener('abort', onAbort);
    }
  }

  /** Ends the run with `error` and discards the worker, state included. */
  private kill(error: Error): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.settle(null, error);
    if (!worker) return Promise.resolve();
    return worker.terminate().then(() => undefined, () => undefined);
  }

  private settle(value: unknown, error: unknown): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    if (error !== null) current.reject(error);
    else current.resolve(value);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./worker-thread${ext}`, import.meta.url));
    worker.unref();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.once('error', (e) => {
        reject(e);
        this.settle(null, e);
      });
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = null;
          this.ready = null;
        }
        this.settle(null, new CancelledError('worker exited'));
      });
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'ready') resolve();
        else if (message.type === 'init-failed') {
          const error = new Error(message.message);
          reject(error);
          void this.kill(error);
        } else void this.onMessage(worker, message);
      });
      this.post(worker, { type: 'init', options: this.init });
    });
    return this.ready;
  }

  private async onMessage(worker: Worker, message: WorkerMessage): Promise<void> {
    switch (message.type) {
      case 'done': return this.settle(message.value, null);
      case 'fail': return this.settle(null, typeof message.error === 'string' ? new Error(message.error) : errorFromData(message.error));
      case 'print': return this.options.onPrint?.(message.text);
      case 'chart': return this.options.onChart?.(message.options as any);
      case 'table': return this.options.onTable?.(message.options as any);
      case 'tool-call': {
        const tool = this.tools.get(message.name);
        try {
          if (!tool) throw new Error(`Unknown tool '${message.name}'`);
          const args = await resolveArguments(tool, message.args as any[], Object.keys(message.kwargs).length ? message.kwargs : null);
          const value = await tool.fn(...args);
          this.post(worker, { type: 'tool-result', id: message.id, value });
        } catch (e) {
          // A Python TypeError from argument resolution keeps its class; a
          // handler's own throw becomes a ToolError on the worker side.
          const error = e instanceof InterpreterError ? errorToData(e) : String(e instanceof Error ? e.message : e);
          this.post(worker, { type: 'tool-result', id: message.id, error });
        }
        return;
      }
    }
  }

  private post(worker: Worker, message: HostMessage): void {
    worker.postMessage(message);
  }
}

export function createWorkerInterpreter(options: WorkerInterpreterOptions = {}): WorkerInterpreter {
  return new WorkerHost(options);
}
