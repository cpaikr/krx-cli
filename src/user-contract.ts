export const PUBLIC_CONTRACT = {
  output: {
    formats: ["json", "table", "ndjson", "csv"] as const,
    interactiveDefault: "table" as const,
    redirectedDefault: "json" as const,
    compositeFormat: "json" as const,
  },
  requests: {
    maxRetries: 3,
  },
  environment: {
    apiKey: "KRX_API_KEY",
    mcpToken: "KRX_MCP_TOKEN",
    mcpAllowedHosts: "KRX_MCP_ALLOWED_HOSTS",
    contractDate: "KRX_CONTRACT_DATE",
  },
} as const;

export type OutputFormat = (typeof PUBLIC_CONTRACT.output.formats)[number];

export function isOutputFormat(value: string): value is OutputFormat {
  return PUBLIC_CONTRACT.output.formats.some((format) => format === value);
}

export function missingApiKeyMessage(): string {
  return `No API key configured. Use 'krx auth set' or set ${PUBLIC_CONTRACT.environment.apiKey} env var.`;
}
