/**
 * calculator tool — Evaluates a mathematical expression and returns the result.
 *
 * Phase C.2 (E1: Agentic Testing)
 *
 * Security: Only allows characters valid in math expressions.
 * Blocks any expression containing code-execution patterns.
 */

import { IToolProvider } from "./IToolProvider";

/** Allowlist of characters safe for math expressions. */
const SAFE_MATH_PATTERN = /^[0-9\s.+\-*/()%**]+$/;

const calculator: IToolProvider = {
  name: "calculator",
  description: "Evaluate a mathematical expression and return the numeric result",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          "A mathematical expression to evaluate (e.g. '2 + 2', '(3 * 4) / 2'). " +
          "Only numeric operators and parentheses are supported.",
      },
    },
    required: ["expression"],
  },

  async execute(
    params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    const expression = params.expression as string;

    // Character-level allowlist: only digits, spaces, and math operators
    if (!SAFE_MATH_PATTERN.test(expression)) {
      return "error: invalid expression — only numeric values and operators (+, -, *, /, %, **) are allowed";
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const result = new Function('"use strict"; return (' + expression + ')')();

      if (typeof result !== "number" || !isFinite(result)) {
        return "error: expression did not evaluate to a finite number";
      }

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: invalid expression — ${msg}`;
    }
  },
};

export default calculator;
