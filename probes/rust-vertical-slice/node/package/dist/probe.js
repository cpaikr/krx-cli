import { binding, nativeTarget } from "./binding.js";
import { KrxError, internalFailure, outcomeValue } from "./errors.js";

export function probeUnsupportedTarget() {
  if (nativeTarget("freebsd", "x64", {}) !== null) {
    throw new Error("unsupported target was accidentally classified");
  }
  throw new KrxError({
    kind: "local_state",
    code: "unsupported_platform",
    message: "this platform has no certified krx native artifact",
    retryable: false,
  });
}

export function probeWireContract() {
  return binding().probeWireContract();
}

export function probeSyncPanic() {
  try {
    binding().probeSyncPanic();
  } catch {
    throw internalFailure();
  }
  throw internalFailure();
}

export async function probeAsyncPanic() {
  try {
    return outcomeValue(await binding().probeAsyncPanic());
  } catch (error) {
    if (error instanceof KrxError) throw error;
    throw internalFailure();
  }
}
