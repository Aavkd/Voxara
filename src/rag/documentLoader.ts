/**
 * Document Loader — loads RAG context documents from files or inline content.
 *
 * Phase D.1 (E2: RAG Testing)
 */

import * as fs from "fs";
import * as path from "path";
import { RagDocument } from "../types";

const MAX_DOCUMENT_CHARS = 100_000;

/**
 * Load an array of RagDocuments and return their raw content strings.
 *
 * @param docs    - Array of document descriptors (file path or inline content).
 * @param baseDir - Base directory used to resolve relative file paths.
 * @returns       - Array of document content strings, one per input document.
 */
export async function loadDocuments(
  docs: RagDocument[],
  baseDir: string
): Promise<string[]> {
  const contents: string[] = [];

  for (const doc of docs) {
    let content: string;

    if (doc.source === "file") {
      if (!doc.path) {
        throw new Error(
          `Document with source "file" is missing a "path" field.`
        );
      }

      const absolutePath = path.resolve(baseDir, doc.path);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(
          `Document file not found: "${absolutePath}"`
        );
      }

      content = fs.readFileSync(absolutePath, "utf-8");
    } else if (doc.source === "inline") {
      if (doc.content === undefined || doc.content === null) {
        throw new Error(
          `Document with source "inline" is missing a "content" field.`
        );
      }
      content = doc.content;
    } else {
      throw new Error(
        `Unknown document source "${(doc as RagDocument).source}". Expected "file" or "inline".`
      );
    }

    if (content.length > MAX_DOCUMENT_CHARS) {
      const label = doc.source === "file" ? `"${doc.path}"` : `(inline)`;
      throw new Error(
        `Document ${label} exceeds the ${MAX_DOCUMENT_CHARS.toLocaleString()}-character limit ` +
          `(got ${content.length.toLocaleString()} characters). ` +
          `Split the document or use a smaller file.`
      );
    }

    contents.push(content);
  }

  return contents;
}
