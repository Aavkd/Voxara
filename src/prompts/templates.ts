export type PromptName =
  | "persona"
  | "agent"
  | "rag"
  | "judge"
  | "judge-strict"
  | "faithfulness"
  | "stt-cleanup"
  | "voice-style"
  | "memory-agent"
  | "memory-hygiene";

export interface PromptTemplateDefinition {
  name: PromptName;
  fileName: string;
  requiredVariables: string[];
  fallback: string;
}

export const PROMPT_TEMPLATES: PromptTemplateDefinition[] = [
  {
    name: "persona",
    fileName: "persona.md",
    requiredVariables: [],
    fallback: "You are a helpful assistant. Be concise, accurate, and practical.",
  },
  {
    name: "agent",
    fileName: "agent.md",
    requiredVariables: [],
    fallback: [
      "You are an agentic assistant with access to local tools.",
      "",
      "Use tools only when they are useful for the user's request. When you call a tool, use the exact tool name and valid parameters. When you have enough information, provide the final answer directly.",
    ].join("\n"),
  },
  {
    name: "rag",
    fileName: "rag.md",
    requiredVariables: ["systemPrompt", "documents", "question"],
    fallback: [
      "{{systemPrompt}}",
      "",
      "{{documents}}",
      "---",
      "",
      "Question: {{question}}",
    ].join("\n"),
  },
  {
    name: "judge",
    fileName: "judge.md",
    requiredVariables: ["criteria", "originalPrompt", "modelResponse"],
    fallback: [
      "You are an impartial evaluator. Score the following model response from 0 to 10.",
      "",
      "CRITERIA: {{criteria}}",
      "ORIGINAL QUESTION: {{originalPrompt}}",
      "MODEL RESPONSE: {{modelResponse}}",
      "",
      "Reply with ONLY a valid JSON object in this exact format:",
      '{ "score": <integer 0-10>, "reason": "<one sentence explanation>" }',
    ].join("\n"),
  },
  {
    name: "judge-strict",
    fileName: "judge-strict.md",
    requiredVariables: ["criteria", "originalPrompt", "modelResponse"],
    fallback: [
      "You are an impartial evaluator.",
      "You MUST reply with ONLY a raw JSON object - no markdown, no explanation outside the JSON, no code fences.",
      "",
      "CRITERIA: {{criteria}}",
      "ORIGINAL QUESTION: {{originalPrompt}}",
      "MODEL RESPONSE: {{modelResponse}}",
      "",
      "Required output format (nothing else):",
      '{"score": <integer from 0 to 10>, "reason": "<one concise sentence>"}',
    ].join("\n"),
  },
  {
    name: "faithfulness",
    fileName: "faithfulness.md",
    requiredVariables: ["documents", "question", "response"],
    fallback: [
      "You are an evaluator assessing whether a model response is grounded in the provided source documents.",
      "",
      "SOURCE DOCUMENTS:",
      "{{documents}}",
      "",
      "QUESTION: {{question}}",
      "MODEL RESPONSE: {{response}}",
      "",
      "Score the response from 0.0 to 1.0 where:",
      "- 1.0 = fully grounded, every claim is supported by the documents",
      "- 0.0 = completely hallucinated, no claims are supported",
      "",
      "Also determine: does the response contain any claims NOT present in the source documents? (true/false)",
      "",
      'Reply with ONLY valid JSON: { "score": <float>, "reason": "<one sentence>", "hallucinated": <boolean> }',
    ].join("\n"),
  },
  {
    name: "stt-cleanup",
    fileName: "stt-cleanup.md",
    requiredVariables: ["transcript"],
    fallback: [
      "Clean up the transcript while preserving the user's meaning.",
      "",
      "Transcript:",
      "{{transcript}}",
    ].join("\n"),
  },
  {
    name: "voice-style",
    fileName: "voice-style.md",
    requiredVariables: [],
    fallback: "Speak in a warm, natural, conversational voice. Keep the delivery clear, calm, and expressive without sounding theatrical.",
  },
  {
    name: "memory-agent",
    fileName: "memory-agent.md",
    requiredVariables: [
      "date",
      "channel",
      "transcript",
      "memoryIndex",
      "factSummaries",
      "inboxNotes",
    ],
    fallback: [
      "You are a memory consolidation agent. You MUST reply with ONLY a raw JSON object - no markdown, no code fences, no text outside the JSON.",
      "",
      "Session date: {{date}} | Channel: {{channel}}",
      "",
      "TRANSCRIPT:",
      "{{transcript}}",
      "",
      "MEMORY INDEX:",
      "{{memoryIndex}}",
      "",
      "EXISTING FACTS:",
      "{{factSummaries}}",
      "",
      "INBOX NOTES:",
      "{{inboxNotes}}",
      "",
      "Write an episode summary of the transcript, extract durable facts (prefer updating an existing fact id over creating a near-duplicate), file the inbox notes, and archive facts the user asked to forget. Write everything in English. New fact ids are kebab-case slugs.",
      "",
      "Required output format (nothing else):",
      '{"episode": {"summary": "...", "decisions": ["..."], "openThreads": ["..."], "hook": "..."} or null, "factUpserts": [{"id": "kebab-case-id", "body": "...", "hook": "..."}], "archiveIds": ["..."]}',
    ].join("\n"),
  },
  {
    name: "memory-hygiene",
    fileName: "memory-hygiene.md",
    requiredVariables: ["factBodies", "memoryIndex", "overBudgetNote"],
    fallback: [
      "You are a memory hygiene agent. You MUST reply with ONLY a raw JSON object - no markdown, no code fences, no text outside the JSON.",
      "",
      "MEMORY INDEX:",
      "{{memoryIndex}}",
      "",
      "FACT FILES (full bodies, with last-updated dates):",
      "{{factBodies}}",
      "",
      "{{overBudgetNote}}",
      "",
      "Merge duplicate/overlapping facts (keepId absorbs absorbIds; the merged body keeps every piece of information) and flag facts that contradict each other (do not pick the winner - the system keeps the most recently updated one). Every merge must absorb at least one fact. Only use ids that appear in FACT FILES. When in doubt, return empty arrays.",
      "",
      "Required output format (nothing else):",
      '{"merges": [{"keepId": "existing-id", "absorbIds": ["existing-id"], "body": "...", "hook": "..."}], "contradictions": [{"ids": ["existing-id", "existing-id"]}]}',
    ].join("\n"),
  },
];

export const PROMPT_TEMPLATE_BY_NAME: Record<PromptName, PromptTemplateDefinition> =
  PROMPT_TEMPLATES.reduce((acc, definition) => {
    acc[definition.name] = definition;
    return acc;
  }, {} as Record<PromptName, PromptTemplateDefinition>);
