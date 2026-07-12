/**
 * memory_note tool — Fast path of "remember that…": appends a raw note to the
 * memory inbox without blocking the conversation. The background memory agent
 * formats and files the note at the next consolidation (Phase M2).
 *
 * Phase M1 (docs/memory-architecture-spec.md §5.2)
 */

import { IToolProvider } from "./IToolProvider";
import { appendInboxNote } from "../../memory/memoryStore";

const memoryNote: IToolProvider = {
  name: "memory_note",
  description:
    "Save something the user asked to remember. Writes a raw note to the long-term memory inbox; it is filed properly later. Call this when the user says things like \"remember that…\", \"retiens que…\", or \"n'oublie pas que…\".",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The exact fact to remember, self-contained and in the user's own terms",
      },
    },
    required: ["text"],
  },

  async execute(
    params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    const text = String(params.text ?? "").trim();
    if (!text) {
      return "error: memory_note requires a non-empty text.";
    }

    appendInboxNote(text, "memory_note tool");
    return "Noted. The memory will be filed at the next consolidation.";
  },
};

export default memoryNote;
