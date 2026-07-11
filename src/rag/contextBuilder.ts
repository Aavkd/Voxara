/**
 * Context Builder — assembles a RAG prompt from documents and a question.
 *
 * Phase D.2 (E2: RAG Testing)
 */

import { renderPrompt } from "../prompts/promptLoader";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer only using the information in the provided documents. If the answer is not in the documents, say so.";

/**
 * Build a structured prompt that injects document context before a question.
 *
 * @param documents   - Array of raw document content strings.
 * @param question    - The user question to answer.
 * @param systemPrompt - Optional override for the default system preamble.
 * @returns            - A single prompt string ready to send to the LLM.
 */
export function buildContextPrompt(
  documents: string[],
  question: string,
  systemPrompt?: string
): string {
  const docSections = documents
    .map((doc, i) => `--- DOCUMENT ${i + 1} ---\n${doc.trim()}`)
    .join("\n");

  return renderPrompt("rag", {
    systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    documents: docSections,
    question,
  });
}
