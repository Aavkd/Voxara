import * as fs from "fs";
import * as path from "path";
import {
  PROMPT_TEMPLATE_BY_NAME,
  PROMPT_TEMPLATES,
  PromptName,
  PromptTemplateDefinition,
} from "./templates";

export type PromptVariables = Record<string, string | number | boolean>;

export interface PromptLoaderOptions {
  promptsDir?: string;
  debug?: boolean;
  warn?: (message: string) => void;
}

export interface PromptValidationResult {
  ok: boolean;
  promptsDir: string;
  checked: string[];
  errors: string[];
  warnings: string[];
}

const VARIABLE_PATTERN = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;

export function resolvePromptsDir(promptsDir?: string): string {
  return path.resolve(process.cwd(), promptsDir || process.env.PROMPTS_DIR || "prompts");
}

export function extractPromptVariables(template: string): string[] {
  const variables = new Set<string>();
  let match: RegExpExecArray | null;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
    variables.add(match[1]);
  }
  return [...variables].sort();
}

export function interpolatePrompt(
  template: string,
  variables: PromptVariables,
  options: { debug?: boolean } = {}
): string {
  const missing = extractPromptVariables(template).filter(
    (variableName) => variables[variableName] === undefined
  );

  if (options.debug && missing.length > 0) {
    throw new Error(
      `Prompt contains unknown variable(s): ${missing.map((name) => `{{${name}}}`).join(", ")}`
    );
  }

  return template.replace(VARIABLE_PATTERN, (fullMatch, variableName: string) => {
    const value = variables[variableName];
    return value === undefined ? fullMatch : String(value);
  });
}

export function loadPromptTemplate(
  name: PromptName,
  options: PromptLoaderOptions = {}
): string {
  const definition = PROMPT_TEMPLATE_BY_NAME[name];
  const promptsDir = resolvePromptsDir(options.promptsDir);
  const filePath = path.join(promptsDir, definition.fileName);

  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const warn = options.warn ?? console.warn;
    const message = err instanceof Error ? err.message : String(err);
    warn(
      `Warning: Prompt file "${filePath}" could not be read (${message}). Using emergency fallback for "${name}".`
    );
    return definition.fallback;
  }
}

export function renderPrompt(
  name: PromptName,
  variables: PromptVariables = {},
  options: PromptLoaderOptions = {}
): string {
  const definition = PROMPT_TEMPLATE_BY_NAME[name];
  const missingRequired = definition.requiredVariables.filter(
    (variableName) => variables[variableName] === undefined
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Prompt "${name}" is missing required variable(s): ${missingRequired.join(", ")}`
    );
  }

  const template = loadPromptTemplate(name, options);
  return interpolatePrompt(template, variables, {
    debug: options.debug ?? process.env.LLMTEST_LOG_LEVEL === "debug",
  });
}

export function validatePrompts(
  options: PromptLoaderOptions = {}
): PromptValidationResult {
  const promptsDir = resolvePromptsDir(options.promptsDir);
  const errors: string[] = [];
  const warnings: string[] = [];
  const checked: string[] = [];

  for (const definition of PROMPT_TEMPLATES) {
    checked.push(definition.fileName);
    validatePromptDefinition(definition, promptsDir, errors, warnings, options.debug ?? false);
  }

  return {
    ok: errors.length === 0,
    promptsDir,
    checked,
    errors,
    warnings,
  };
}

function validatePromptDefinition(
  definition: PromptTemplateDefinition,
  promptsDir: string,
  errors: string[],
  warnings: string[],
  debug: boolean
): void {
  const filePath = path.join(promptsDir, definition.fileName);

  if (!fs.existsSync(filePath)) {
    errors.push(`Missing required prompt file: ${filePath}`);
    return;
  }

  let template: string;
  try {
    template = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Cannot read prompt file "${filePath}": ${message}`);
    return;
  }

  if (template.trim().length === 0) {
    errors.push(`Prompt file is empty: ${filePath}`);
  }

  const declaredVariables = extractPromptVariables(template);
  for (const required of definition.requiredVariables) {
    if (!declaredVariables.includes(required)) {
      errors.push(
        `Prompt "${definition.name}" must include required variable {{${required}}}.`
      );
    }
  }

  const unknownVariables = declaredVariables.filter(
    (variableName) => !definition.requiredVariables.includes(variableName)
  );
  if (unknownVariables.length > 0) {
    const message =
      `Prompt "${definition.name}" contains unregistered variable(s): ` +
      unknownVariables.map((name) => `{{${name}}}`).join(", ");
    if (debug) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }
}
