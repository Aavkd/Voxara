/**
 * IToolProvider — Interface that every built-in (and future) tool must implement.
 *
 * Phase C.1 (E1: Agentic Testing)
 */

export interface IToolProvider {
  /** Unique tool name used in suite JSON and Gemini function declarations. */
  name: string;

  /** Human-readable description passed to the model. */
  description: string;

  /**
   * JSON Schema object describing the tool's accepted parameters.
   * Passed verbatim to the model as the function's parameter schema.
   */
  parameters: Record<string, unknown>;

  /**
   * Execute the tool with the given parameters inside the sandbox directory.
   *
   * @param params     - The parameters extracted from the model's function call.
   * @param sandboxDir - The absolute path of the sandboxed working directory.
   * @returns          - The tool result (string, number, object, etc.)
   */
  execute(
    params: Record<string, unknown>,
    sandboxDir: string
  ): Promise<unknown>;
}
