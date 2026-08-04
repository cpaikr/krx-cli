import type { Readable, Writable } from "node:stream";

interface SecretInputOptions {
  readonly input?: NodeJS.ReadStream | Readable;
  readonly output?: NodeJS.WriteStream | Writable;
  readonly prompt?: string;
}

async function readToEnd(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Read a secret without terminal echo, or from piped stdin for automation. */
export async function readSecret(
  options: SecretInputOptions = {},
): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const prompt = options.prompt ?? "KRX API key: ";
  const terminal = input as NodeJS.ReadStream;

  if (!terminal.isTTY || typeof terminal.setRawMode !== "function") {
    return readToEnd(input);
  }

  output.write(prompt);
  terminal.setRawMode(true);
  terminal.resume();
  terminal.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let secret = "";
    let settled = false;

    const restore = (): void => {
      terminal.off("data", onData);
      terminal.off("error", onError);
      terminal.off("end", onEnd);
      terminal.off("close", onClose);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      terminal.setRawMode(false);
      terminal.pause();
      output.write("\n");
    };

    const finish = (result: { value: string } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      try {
        restore();
      } catch (error) {
        reject(
          new Error("Failed to restore terminal after API key input", {
            cause: error,
          }),
        );
        return;
      }
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };

    const onError = (error: Error): void => finish({ error });
    const onEnd = (): void =>
      finish({ error: new Error("API key input ended before submission") });
    const onClose = (): void =>
      finish({ error: new Error("API key input closed before submission") });
    const onSignal = (signal: NodeJS.Signals): void =>
      finish({ error: new Error(`API key input interrupted by ${signal}`) });

    const onData = (chunk: string | Buffer): void => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish({ value: secret.trim() });
          return;
        }
        if (character === "\u0003") {
          finish({ error: new Error("API key input cancelled") });
          return;
        }
        if (character === "\u0004") {
          finish({ error: new Error("API key input ended before submission") });
          return;
        }
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else if (character >= " ") {
          secret += character;
        }
      }
    };

    terminal.on("data", onData);
    terminal.on("error", onError);
    terminal.on("end", onEnd);
    terminal.on("close", onClose);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
  });
}
