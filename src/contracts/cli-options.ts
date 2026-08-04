export interface ContractCliOptions {
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly date?: string;
  readonly reportPath?: string;
}

/** Parse direct Node arguments and the literal separator forwarded by pnpm. */
export function parseContractArguments(
  args: readonly string[],
): ContractCliOptions {
  let dryRun = false;
  let help = false;
  let date: string | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--date") {
      date = args[++index];
      if (!date) throw new Error("--date requires YYYYMMDD");
    } else if (argument === "--report") {
      reportPath = args[++index];
      if (!reportPath) throw new Error("--report requires a path");
    } else if (argument === "--help") {
      help = true;
    } else {
      throw new Error(`Unknown option: ${argument ?? ""}`);
    }
  }
  return {
    dryRun,
    help,
    ...(date ? { date } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}
