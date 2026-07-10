/**
 * Custom error types for the Python interpreter
 */

export class InterpreterError extends Error {
  public baseMessage: string;
  
  constructor(
    message: string,
    public line: number,
    public column: number
  ) {
    super(`Line ${line}, Column ${column}: ${message}`);
    this.baseMessage = message;
    this.name = 'InterpreterError';
  }
}

export class SyntaxError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'SyntaxError';
  }
}

export class NameError extends InterpreterError {
  constructor(name: string, line: number, column: number) {
    super(`Name '${name}' is not defined`, line, column);
    this.name = 'NameError';
  }
}

export class TypeError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'TypeError';
  }
}

export class IndexError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'IndexError';
  }
}

export class KeyError extends InterpreterError {
  constructor(key: string, line: number, column: number) {
    super(`KeyError: '${key}'`, line, column);
    this.name = 'KeyError';
  }
}

export class ValueError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'ValueError';
  }
}

export class ZeroDivisionError extends InterpreterError {
  constructor(line: number, column: number) {
    super('Division by zero', line, column);
    this.name = 'ZeroDivisionError';
  }
}

export class StopIteration extends InterpreterError {
  constructor(line: number, column: number) {
    super('StopIteration', line, column);
    this.name = 'StopIteration';
  }
}

export class OverflowError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'OverflowError';
  }
}

export class StatisticsError extends ValueError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'StatisticsError';
  }
}

export class ImportError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'ImportError';
  }
}

export class ModuleNotFoundError extends ImportError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'ModuleNotFoundError';
  }
}

export class MaxIterationsError extends InterpreterError {
  constructor(line: number, column: number) {
    super('Maximum iterations exceeded (possible infinite loop)', line, column);
    this.name = 'MaxIterationsError';
  }
}

/** Wall-clock deadline exceeded (timeoutMs option). Like MaxIterationsError,
 *  this is a host resource bound — deliberately not catchable from Python. */
export class TimeoutError extends InterpreterError {
  constructor(timeoutMs: number, line: number, column: number) {
    super(`Execution exceeded the ${timeoutMs}ms time limit`, line, column);
    this.name = 'TimeoutError';
  }
}

/** Result of an operation would exceed the configured memory limits.
 *  Catchable from Python as MemoryError / Exception, like CPython. */
export class MemoryError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'MemoryError';
  }
}

export class RuntimeError extends InterpreterError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'RuntimeError';
  }
}

/** A JS tool handler threw. Catchable from Python as ToolError, RuntimeError,
 *  or Exception, so scripts can implement fallbacks. */
export class ToolError extends RuntimeError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = 'ToolError';
  }
}

