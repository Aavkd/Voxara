/**
 * Tool Registry — maps tool names to their IToolProvider implementations.
 *
 * Phase C.2 (E1: Agentic Testing)
 */

import { IToolProvider } from "./IToolProvider";
import fileRead from "./fileRead";
import fileWrite from "./fileWrite";
import calculator from "./calculator";
import getCurrentTime from "./getCurrentTime";
import memoryRead from "./memoryRead";
import memoryNote from "./memoryNote";

/** Registry of all built-in tools, keyed by tool name. */
export const TOOL_REGISTRY: Record<string, IToolProvider> = {
  [fileRead.name]: fileRead,
  [fileWrite.name]: fileWrite,
  [calculator.name]: calculator,
  [getCurrentTime.name]: getCurrentTime,
  [memoryRead.name]: memoryRead,
  [memoryNote.name]: memoryNote,
};

/**
 * Resolve a list of tool names to their IToolProvider implementations.
 * Throws a descriptive error if any name is not found in the registry.
 *
 * @param names - Array of tool names (as specified in the suite JSON).
 * @returns     - The corresponding IToolProvider instances.
 */
export function getTools(names: string[]): IToolProvider[] {
  const validNames = Object.keys(TOOL_REGISTRY);
  const unknown: string[] = [];

  const tools = names.map((name) => {
    if (!TOOL_REGISTRY[name]) {
      unknown.push(name);
      return null;
    }
    return TOOL_REGISTRY[name];
  });

  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool(s): ${unknown.join(", ")}. ` +
        `Valid tools are: ${validNames.join(", ")}.`
    );
  }

  return tools as IToolProvider[];
}

/** Return every tool registered in the registry. */
export function getAllTools(): IToolProvider[] {
  return Object.values(TOOL_REGISTRY);
}

/** Return every registered tool name. */
export function getAllToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}
