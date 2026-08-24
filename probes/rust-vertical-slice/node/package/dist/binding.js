import { createRequire } from "node:module";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { KrxError } from "./errors.js";

const require = createRequire(import.meta.url);
let loaded;

export function nativeTarget(
  platform = process.platform,
  arch = process.arch,
  report = process.report?.getReport?.(),
) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    if (!report?.header?.glibcVersionRuntime) return null;
    return `linux-${arch}-gnu`;
  }
  return null;
}

export function binding(target = nativeTarget()) {
  if (target === undefined || target === null) {
    throw new KrxError({
      kind: "local_state",
      code: "unsupported_platform",
      message: "this platform has no certified krx native artifact",
      retryable: false,
    });
  }
  if (loaded && target === nativeTarget()) return loaded;
  const path = fileURLToPath(
    new URL(`../native/krx.${target}.node`, import.meta.url),
  );
  const value = require(path);
  if (target === nativeTarget()) loaded = value;
  return value;
}
