/**
 * file_read tool — Reads the contents of a file within the sandbox directory.
 *
 * Phase C.2 (E1: Agentic Testing)
 */

import * as fs from "fs";
import * as path from "path";
import { IToolProvider } from "./IToolProvider";

const fileRead: IToolProvider = {
  name: "file_read",
  description: "Read the contents of a file",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the file, relative to the sandbox directory",
      },
    },
    required: ["path"],
  },

  async execute(
    params: Record<string, unknown>,
    sandboxDir: string
  ): Promise<unknown> {
    const filePath = params.path as string;

    // Sandbox escape prevention: reject absolute paths and path traversal
    if (path.isAbsolute(filePath) || filePath.includes("..")) {
      throw new Error(
        `Sandbox escape blocked: "${filePath}" is not a valid relative path. ` +
          `Use paths relative to the sandbox directory and do not use "..".`
      );
    }

    const resolvedPath = path.join(sandboxDir, filePath);

    try {
      return fs.readFileSync(resolvedPath, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: could not read file "${filePath}": ${msg}`;
    }
  },
};

export default fileRead;
