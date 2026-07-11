/**
 * JSON Schema Validator — validates parsed JSON data against a JSON Schema using ajv.
 * Also provides minimal JSONPath evaluation for dotted paths ($.field, $.field.subfield).
 */

import Ajv, { ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true });

/**
 * Validate `data` against a JSON Schema object.
 * Returns { valid: true, errors: [] } on success.
 * Returns { valid: false, errors: [...messages] } on failure.
 */
export function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const validate = ajv.compile(schema);
  const valid = validate(data) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map((e: ErrorObject) => {
    const path = e.instancePath || "(root)";
    return `${path}: ${e.message ?? "validation error"}`;
  });

  return { valid: false, errors };
}

/**
 * Evaluate minimal JSONPath assertions against parsed data.
 * Supports only dotted paths: $.field, $.field.subfield, etc.
 * Returns { passed: true, failures: [] } if all assertions pass.
 */
export function evaluateJsonPath(
  data: unknown,
  assertions: Array<{ path: string; equals: unknown }>
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const assertion of assertions) {
    const actual = resolvePath(data, assertion.path);
    if (!deepEqual(actual, assertion.equals)) {
      failures.push(
        `${assertion.path}: expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Resolve a dotted JSONPath expression ($.a.b.c) against a value.
 * Returns `undefined` if the path cannot be resolved.
 */
function resolvePath(data: unknown, path: string): unknown {
  // Strip leading "$." or "$"
  const stripped = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : path;

  if (stripped === "" || stripped === ".") {
    return data;
  }

  const segments = stripped.split(".");
  let current: unknown = data;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Deep equality check for primitive values and plain objects/arrays.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    return aStr === bStr;
  }
  return false;
}
