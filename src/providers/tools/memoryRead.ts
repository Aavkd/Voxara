/**
 * memory_read tool — Reads one long-term memory entry (fact or episode).
 *
 * Phase M1 (docs/memory-architecture-spec.md §4)
 */

import { IToolProvider } from "./IToolProvider";
import { readMemoryEntry } from "../../memory/memoryStore";

const memoryRead: IToolProvider = {
  name: "memory_read",
  description:
    "Read the full content of one long-term memory entry. Entry ids come from the memory index shown in the conversation context.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          'The memory entry id, e.g. "user-prefers-short-answers" (the file stem, without .md or any directory)',
      },
    },
    required: ["id"],
  },

  async execute(
    params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    const id = String(params.id ?? "").trim();
    if (!id) {
      return "error: memory_read requires a non-empty id.";
    }

    const entry = readMemoryEntry(id);
    if (!entry) {
      return `error: no memory entry found with id "${id}". Use an id from the memory index.`;
    }

    return entry.content;
  },
};

export default memoryRead;
