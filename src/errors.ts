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

export class MaxIterationsError extends InterpreterError {
  constructor(line: number, column: number) {
    super('Maximum iterations exceeded (possible infinite loop)', line, column);
    this.name = 'MaxIterationsError';
  }
}

