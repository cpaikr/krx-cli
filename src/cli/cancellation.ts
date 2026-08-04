export async function withCliCancellation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancelRequest = (): void => controller.abort();
  process.once("SIGINT", cancelRequest);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", cancelRequest);
  }
}
