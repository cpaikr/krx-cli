import { describe, expect, it, vi } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { readSecret } from "../../src/cli/secret-input.js";

describe("secret input", () => {
  it("reads and trims a secret from non-interactive stdin", async () => {
    const input = Readable.from(["  secret-from-stdin\n"]);
    const output = new Writable({ write: (_chunk, _encoding, done) => done() });

    await expect(readSecret({ input, output })).resolves.toBe(
      "secret-from-stdin",
    );
  });

  it("restores terminal mode when interactive input fails", async () => {
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.defineProperty(input, "isTTY", { value: true });
    input.setRawMode = vi.fn(() => input);
    let outputText = "";
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        outputText += String(chunk);
        done();
      },
    });

    const pending = readSecret({ input, output });
    input.emit("error", new Error("terminal disconnected"));

    await expect(pending).rejects.toThrow("terminal disconnected");
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(outputText).toBe("KRX API key: \n");
  });

  it("treats Ctrl-D as cancellation and restores terminal mode", async () => {
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.defineProperty(input, "isTTY", { value: true });
    input.setRawMode = vi.fn(() => input);
    const output = new Writable({ write: (_chunk, _encoding, done) => done() });

    const pending = readSecret({ input, output });
    input.write("\u0004");

    await expect(pending).rejects.toThrow("ended before submission");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
