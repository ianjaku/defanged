/**
 * Differential tests against CPython.
 *
 * Each case in tests/conformance/cases.ts is a small program. Its printed
 * output and the exception that ends it (if any) must match what CPython
 * produced, as recorded in tests/conformance/expected.json by
 * `bun run conformance:record`.
 */

import { describe, test, expect } from 'bun:test';
import { createInterpreter } from '../src';
import { collections } from '../src/collections';
import { itertools } from '../src/itertools';
import { json } from '../src/json';
import { cases } from './conformance/cases';
import expected from './conformance/expected.json';

interface Outcome {
  stdout: string;
  error: { type: string; message: string } | null;
}

async function run(code: string): Promise<Outcome> {
  const lines: string[] = [];
  const interpreter = createInterpreter({ onPrint: (line) => lines.push(line), timeoutMs: 5000, modules: [json, itertools, collections] });
  let error: Outcome['error'] = null;
  try {
    await interpreter.run(code);
  } catch (e: any) {
    // KeyError's host-facing message carries a "KeyError: " prefix that str(e) lacks.
    const message = String(e.baseMessage ?? e.message).replace(/^KeyError: /, '');
    error = { type: e.constructor?.pyName ?? e.name, message };
  }
  return { stdout: lines.map((line) => line + '\n').join(''), error };
}

describe(`CPython ${expected.python} conformance`, () => {
  const recorded = expected.cases as Record<string, Outcome>;
  for (const { name, code, message } of cases) {
    test(name, async () => {
      const want = recorded[name];
      if (!want) throw new Error(`No recorded outcome for "${name}" — run: bun run conformance:record`);
      const got = await run(code);
      expect(got.stdout).toBe(want.stdout);
      expect(got.error?.type ?? null).toBe(want.error?.type ?? null);
      if (message !== false) expect(got.error?.message ?? null).toBe(want.error?.message ?? null);
    });
  }
});
