import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { parseContractArguments, resolveContractDate } from "./cli-options.js";
import { buildContractPlan, runContractCheck } from "./runner.js";
import { PUBLIC_CONTRACT } from "../user-contract.js";
import { loadLocalContractEnvironment } from "./local-env.js";

function usage(): string {
  return `Usage: krx-contract-check [options]

Options:
  --dry-run         Print the planned credentialed and official request counts
  --date YYYYMMDD   Probe a confirmed trading date (default: verified KRX session)
  --report PATH     Atomically write the redacted JSON report to PATH
  --help            Show this help`;
}

function emit(value: unknown, reportPath?: string): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(json);
  if (reportPath) {
    writeFileAtomicSync(reportPath, json, { enforceDirectoryMode: false });
  }
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
}

loadLocalContractEnvironment();

const options = parseContractArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const date = resolveContractDate(
  options.date,
  process.env[PUBLIC_CONTRACT.environment.contractDate],
);
const plan = buildContractPlan(date);

if (options.dryRun) {
  emit(
    {
      version: 1,
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      plan,
      note: "Dry-run performs no network requests and consumes no KRX quota.",
    },
    options.reportPath,
  );
} else {
  const apiKey = process.env[PUBLIC_CONTRACT.environment.apiKey] ?? "";
  try {
    const report = await runContractCheck({ apiKey, date: plan.date });
    emit(report, options.reportPath);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : "Contract check failed",
      apiKey,
    );
    emit(
      {
        version: 1,
        mode: "live",
        generatedAt: new Date().toISOString(),
        passed: false,
        plan,
        fatalError: message,
      },
      options.reportPath,
    );
    process.exitCode = 1;
  }
}
