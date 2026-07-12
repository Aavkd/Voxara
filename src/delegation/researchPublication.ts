/**
 * Publish scratch-workspace reports into the user's agent-owned deliverable
 * root (phase C2d-4). Scratch contents are untrusted: traversal, symlinks,
 * oversized output, and filename collisions are handled here.
 */

import * as fs from "fs";
import * as path from "path";

export const MAX_PUBLISHED_FILES = 20;
export const MAX_PUBLISHED_BYTES = 10 * 1024 * 1024;

export interface ScratchBaseline {
  files: Set<string>;
}

export interface ResearchPublicationResult {
  ok: boolean;
  paths: string[];
  error?: string;
}

/** Record files staged by the application before the backend starts. */
export function snapshotScratchFiles(scratchDir: string): ScratchBaseline {
  return { files: new Set(listRegularFiles(scratchDir).map((f) => f.relative)) };
}

export function buildResearchPrompt(task: string): string {
  return (
    task.trim() +
    "\n\nResearch deliverable requirement: Write your full report to `report.md` " +
    "in your working directory. The summary you print is only an abstract; " +
    "it does not replace the report file."
  );
}

/**
 * Publish new regular files from a scratch run. When none exist, persist the
 * bounded backend summary as a Markdown report so success always has a file.
 */
export function publishScratchResearch(options: {
  scratchDir: string;
  agentOwnedRoot: string;
  task: string;
  summary: string;
  baseline: ScratchBaseline;
  now?: Date;
  maxFiles?: number;
  maxBytes?: number;
}): ResearchPublicationResult {
  const maxFiles = options.maxFiles ?? MAX_PUBLISHED_FILES;
  const maxBytes = options.maxBytes ?? MAX_PUBLISHED_BYTES;
  const date = localDate(options.now ?? new Date());
  const slug = slugify(options.task);
  const reportsRoot = path.resolve(options.agentOwnedRoot, "rapports");

  try {
    fs.mkdirSync(reportsRoot, { recursive: true });
    const created = listRegularFiles(options.scratchDir).filter(
      (file) => !options.baseline.files.has(file.relative)
    );

    if (created.length === 0) {
      const reportFile = uniquePath(reportsRoot, `${date}-${slug}`, ".md");
      fs.writeFileSync(
        reportFile,
        `# Rapport de recherche\n\n${options.summary.trim() || "La recherche s'est terminée sans résumé."}\n`,
        "utf-8"
      );
      return { ok: true, paths: [reportFile] };
    }

    const destinationDir = uniqueDirectory(reportsRoot, `${date}-${slug}`);
    const published: string[] = [];
    let totalBytes = 0;

    for (const file of created) {
      if (published.length >= maxFiles || totalBytes + file.size > maxBytes) {
        break;
      }
      const safeParts = file.relative
        .split(/[\\/]+/)
        .filter(Boolean)
        .map(sanitizeName);
      if (safeParts.length === 0) {
        continue;
      }
      let destination = path.resolve(destinationDir, ...safeParts);
      if (!isInside(destinationDir, destination)) {
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      destination = uniqueFile(destination);
      fs.copyFileSync(file.absolute, destination, fs.constants.COPYFILE_EXCL);
      published.push(destination);
      totalBytes += file.size;
    }

    if (published.length === 0) {
      fs.rmSync(destinationDir, { recursive: true, force: true });
      const reportFile = uniquePath(reportsRoot, `${date}-${slug}`, ".md");
      fs.writeFileSync(
        reportFile,
        `# Rapport de recherche\n\n${options.summary.trim() || "La recherche s'est terminée sans résumé."}\n`,
        "utf-8"
      );
      return { ok: true, paths: [reportFile] };
    }

    return { ok: true, paths: published };
  } catch (err: unknown) {
    return {
      ok: false,
      paths: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function listRegularFiles(root: string): Array<{
  relative: string;
  absolute: string;
  size: number;
}> {
  const files: Array<{ relative: string; absolute: string; size: number }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.resolve(dir, entry.name);
      if (!isInside(root, absolute) || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(absolute);
        files.push({
          relative: path.relative(root, absolute),
          absolute,
          size: stat.size,
        });
      }
    }
  };
  walk(path.resolve(root));
  return files;
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "recherche";
}

function sanitizeName(name: string): string {
  const extension = path.extname(name).slice(0, 20);
  const stem = path.basename(name, path.extname(name));
  const safeStem = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+$/g, "file")
    .slice(0, 100) || "file";
  const safeExtension = extension.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  return `${safeStem}${safeExtension}`;
}

function uniqueDirectory(parent: string, name: string): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.resolve(parent, i === 1 ? name : `${name}-${i}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("could not allocate a unique report directory");
}

function uniquePath(parent: string, stem: string, extension: string): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.resolve(
      parent,
      `${i === 1 ? stem : `${stem}-${i}`}${extension}`
    );
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique report path");
}

function uniqueFile(file: string): string {
  if (!fs.existsSync(file)) return file;
  const extension = path.extname(file);
  const stem = file.slice(0, -extension.length || undefined);
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem}-${i}${extension}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique published filename");
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + path.sep)
  );
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
