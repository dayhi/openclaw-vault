import { readJsonFile, writeJsonFileAtomic } from "./json-file.js";

export type ProviderBackupFile = {
  version: 1;
  providers: Record<string, string>;
};

const EMPTY_PROVIDER_BACKUP: ProviderBackupFile = {
  version: 1,
  providers: {},
};

function normalizeProviders(providers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(providers)
      .filter(([providerId, baseUrl]) => providerId.trim() && typeof baseUrl === "string" && baseUrl.trim())
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isProviderBackupFile(value: unknown): value is ProviderBackupFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { version?: unknown; providers?: unknown };
  if (candidate.version !== 1 || typeof candidate.providers !== "object" || candidate.providers === null) {
    return false;
  }
  return Object.values(candidate.providers).every((entry) => typeof entry === "string");
}

export class ProviderBackupStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ProviderBackupFile> {
    const parsed = await readJsonFile(this.filePath);
    if (!isProviderBackupFile(parsed)) {
      return { ...EMPTY_PROVIDER_BACKUP, providers: {} };
    }
    return {
      version: 1,
      providers: normalizeProviders(parsed.providers),
    };
  }

  async replaceAll(providers: Record<string, string>): Promise<void> {
    await writeJsonFileAtomic(this.filePath, { version: 1, providers: normalizeProviders(providers) });
  }
}
