/**
 * file_write tool — Writes content to a file within the sandbox directory.
 *
 * Phase C.2 (E1: Agentic Testing)
 */

import * as fs from "fs";
import * as path from "path";
import { IToolProvider } from "./IToolProvider";

const fileWrite: IToolProvider = {
  name: "file_write",
  description: "Write content to a file",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the file, relative to the sandbox directory",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },

  async execute(
    params: Record<string, unknown>,
    sandboxDir: string
  ): Promise<unknown> {
    const filePath = params.path as string;
    const content = params.content as string;

    // Sandbox escape prevention: reject absolute paths and path traversal
    if (path.isAbsolute(filePath) || filePath.includes("..")) {
      throw new Error(
        `Sandbox escape blocked: "${filePath}" is not a valid relative path. ` +
          `Use paths relative to the sandbox directory and do not use "..".`
      );
    }

    const resolvedPath = path.join(sandboxDir, filePath);

    try {
      // Ensure parent directories exist
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, content, "utf-8");
      return "success";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: could not write file "${filePath}": ${msg}`;
    }
  },
};

export default fileWrite;
