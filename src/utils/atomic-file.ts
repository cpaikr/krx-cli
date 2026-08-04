import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  readonly directoryMode?: number;
  readonly enforceDirectoryMode?: boolean;
  readonly fileMode?: number;
}

/** Write a complete file beside its destination, then atomically rename it. */
export function writeFileAtomicSync(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const directoryMode = options.directoryMode ?? 0o700;
  const fileMode = options.fileMode ?? 0o600;
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  fs.mkdirSync(directory, { recursive: true, mode: directoryMode });
  if (process.platform !== "win32" && options.enforceDirectoryMode !== false) {
    fs.chmodSync(directory, directoryMode);
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", fileMode);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    if (process.platform !== "win32") {
      fs.fchmodSync(descriptor, fileMode);
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);

    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename may already have completed or the temporary file may not exist.
    }
    throw error;
  }
}
