/**
 * get_current_time tool — Returns the current UTC date and time as an ISO 8601 string.
 *
 * Phase C.2 (E1: Agentic Testing)
 */

import { IToolProvider } from "./IToolProvider";

const getCurrentTime: IToolProvider = {
  name: "get_current_time",
  description: "Get the current UTC date and time as an ISO 8601 string",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(
    _params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    return new Date().toISOString();
  },
};

export default getCurrentTime;
