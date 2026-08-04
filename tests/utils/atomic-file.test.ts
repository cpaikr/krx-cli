import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomicSync } from "../../src/utils/atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic file writes", () => {
  it.skipIf(process.platform === "win32")(
    "can preserve an existing parent directory mode",
    () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "krx-atomic-file-"),
      );
      temporaryDirectories.push(directory);
      fs.chmodSync(directory, 0o755);

      const filePath = path.join(directory, "report.json");
      writeFileAtomicSync(filePath, "{}\n", {
        enforceDirectoryMode: false,
      });

      expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(filePath, "utf8")).toBe("{}\n");
    },
  );
});
