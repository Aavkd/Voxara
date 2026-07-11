/**
 * imageLoader — Load an image file and return its MIME type and base64-encoded data.
 *
 * Phase H.1 (E7: Multi-modal Input)
 */

import * as fs from "fs";
import * as path from "path";

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Load an image from the given file path and return its MIME type and base64 data.
 *
 * @throws if the file does not exist, or if the extension is unsupported.
 */
export async function loadImage(
  filePath: string
): Promise<{ mimeType: string; data: string }> {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeType = SUPPORTED_EXTENSIONS[ext];

  if (!mimeType) {
    const supported = Object.keys(SUPPORTED_EXTENSIONS).join(", ");
    throw new Error(
      `Unsupported image extension "${ext}". Supported types: ${supported}`
    );
  }

  const buffer = fs.readFileSync(resolved);
  return { mimeType, data: buffer.toString("base64") };
}
