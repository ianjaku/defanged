/**
 * Python exceptions.
 *
 * Each class here is both the JS error the host catches and the object a
 * script sees in `except E as e`. The JS class hierarchy mirrors CPython's,
 * so `instanceof` answers `except` matching.
 */

export class InterpreterError extends Error {
  /** Name scripts see (`type(e).__name__`); the base class is `Exception`. */
  static pyName = 'Exception';

  /** Message without the `Line N, Column N:` prefix. */
  public baseMessage: string;
  /** Python-level `e.args`; `str(e)` is derived from these. */
  public args: unknown[];

  constructor(message: string = '', public line: number = 0, public column: number = 0) {
    super(line > 0 ? `Line ${line}, Column ${column}: ${message}` : message);
    this.baseMessage = message;
    this.args = message === '' ? [] : [message];
    this.name = 'InterpreterError';
  }

  /** Stamps a source position onto an error raised without one. */
  setPosition(line: number, column: number): void {
    this.line = line;
    this.column = column;
    this.message = `Line ${line}, Column ${column}: ${this.baseMessage}`;
  }
}

/** Declares an exception class whose `name` and Python name are both `name`. */
function define<B extends typeof InterpreterError>(name: string, Base: B) {
  const cls = class extends (Base as typeof InterpreterError) {
    static pyName = name;
    constructor(message: string = '', line: number = 0, column: number = 0) {
      super(message, line, column);
      this.name = name;
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

export const SyntaxError = define('SyntaxError', InterpreterError);
export type SyntaxError = InstanceType<typeof SyntaxError>;

export const NameError = define('NameError', InterpreterError);
export type NameError = InstanceType<typeof NameError>;

export const UnboundLocalError = define('UnboundLocalError', NameError);
export type UnboundLocalError = InstanceType<typeof UnboundLocalError>;

export const TypeError = define('TypeError', InterpreterError);
export type TypeError = InstanceType<typeof TypeError>;

export const AttributeError = define('AttributeError', InterpreterError);
export type AttributeError = InstanceType<typeof AttributeError>;

export const LookupError = define('LookupError', InterpreterError);
export type LookupError = InstanceType<typeof LookupError>;

export const IndexError = define('IndexError', LookupError);
export type IndexError = InstanceType<typeof IndexError>;

/** `str(e)` is the repr of the missing key, like CPython; the host-facing
 *  message keeps a `KeyError:` prefix because a bare `'k'` says nothing. */
export class KeyError extends LookupError {
  static pyName = 'KeyError';
  constructor(keyRepr: string = '', line: number = 0, column: number = 0) {
    super(`KeyError: ${keyRepr}`, line, column);
    this.name = 'KeyError';
  }
}

export const ValueError = define('ValueError', InterpreterError);
export type ValueError = InstanceType<typeof ValueError>;

export const StatisticsError = define('StatisticsError', ValueError);
export type StatisticsError = InstanceType<typeof StatisticsError>;

export const ArithmeticError = define('ArithmeticError', InterpreterError);
export type ArithmeticError = InstanceType<typeof ArithmeticError>;

export class ZeroDivisionError extends ArithmeticError {
  static pyName = 'ZeroDivisionError';
  constructor(message: string = 'division by zero', line: number = 0, column: number = 0) {
    super(message, line, column);
    this.name = 'ZeroDivisionError';
  }
}

export const OverflowError = define('OverflowError', ArithmeticError);
export type OverflowError = InstanceType<typeof OverflowError>;

export const AssertionError = define('AssertionError', InterpreterError);
export type AssertionError = InstanceType<typeof AssertionError>;

export const StopIteration = define('StopIteration', InterpreterError);
export type StopIteration = InstanceType<typeof StopIteration>;

export const ImportError = define('ImportError', InterpreterError);
export type ImportError = InstanceType<typeof ImportError>;

export const ModuleNotFoundError = define('ModuleNotFoundError', ImportError);
export type ModuleNotFoundError = InstanceType<typeof ModuleNotFoundError>;

/** Result of an operation would exceed the configured memory limits.
 *  Catchable from Python as MemoryError / Exception, like CPython. */
export const MemoryError = define('MemoryError', InterpreterError);
export type MemoryError = InstanceType<typeof MemoryError>;

export const RuntimeError = define('RuntimeError', InterpreterError);
export type RuntimeError = InstanceType<typeof RuntimeError>;

export const RecursionError = define('RecursionError', RuntimeError);
export type RecursionError = InstanceType<typeof RecursionError>;

export const NotImplementedError = define('NotImplementedError', RuntimeError);
export type NotImplementedError = InstanceType<typeof NotImplementedError>;

/** A JS tool handler threw. Catchable from Python as ToolError, RuntimeError,
 *  or Exception, so scripts can implement fallbacks. */
export const ToolError = define('ToolError', RuntimeError);
export type ToolError = InstanceType<typeof ToolError>;

/** Host resource bounds. Scripts cannot catch these, not even with a bare
 *  `except:`, and `finally` blocks do not run for them. */
export class MaxIterationsError extends InterpreterError {
  static pyName = 'MaxIterationsError';
  constructor(line: number = 0, column: number = 0) {
    super('Maximum iterations exceeded (possible infinite loop)', line, column);
    this.name = 'MaxIterationsError';
  }
}

export class TimeoutError extends InterpreterError {
  static pyName = 'TimeoutError';
  constructor(timeoutMs: number, line: number = 0, column: number = 0) {
    super(`Execution exceeded the ${timeoutMs}ms time limit`, line, column);
    this.name = 'TimeoutError';
  }
}

export function isUncatchable(error: unknown): boolean {
  return error instanceof MaxIterationsError || error instanceof TimeoutError;
}

/** Every exception class a script can name, in definition order. */
export const EXCEPTION_CLASSES: (typeof InterpreterError)[] = [
  InterpreterError, SyntaxError, NameError, UnboundLocalError, TypeError, AttributeError, LookupError,
  IndexError, KeyError, ValueError, StatisticsError, ArithmeticError,
  ZeroDivisionError, OverflowError, AssertionError, StopIteration, ImportError,
  ModuleNotFoundError, MemoryError, RuntimeError, RecursionError,
  NotImplementedError, ToolError,
];
