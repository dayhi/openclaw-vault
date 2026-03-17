import { createHash } from "node:crypto";
import { createAsyncLock, readJsonFile, writeJsonFileAtomic } from "./json-file.js";

export type SecretRecord = {
  name: string;
  value: string;
};

export type SecretListItem = {
  name: string;
  length: number;
  digest: string;
};

type SecretRegistryFile = {
  version: 1;
  secrets: SecretRecord[];
};

const EMPTY_SECRET_REGISTRY: SecretRegistryFile = {
  version: 1,
  secrets: [],
};

function normalizeName(name: string): string {
  return name.trim();
}

function assertSecretName(name: string): string {
  const normalized = normalizeName(name);
  if (!normalized) {
    throw new Error("secret name is required");
  }
  if (/\s/.test(normalized)) {
    throw new Error("secret name cannot contain whitespace");
  }
  return normalized;
}

function assertSecretValue(value: string): string {
  if (!value) {
    throw new Error("secret value is required");
  }
  if (/[\r\n]/.test(value)) {
    throw new Error("secret value must be a single line");
  }
  return value;
}

function summarizeSecret(value: string): SecretListItem["digest"] {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isSecretRegistryFile(value: unknown): value is SecretRegistryFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { version?: unknown; secrets?: unknown };
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.secrets) &&
    candidate.secrets.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        typeof (entry as { value?: unknown }).value === "string",
    )
  );
}

function sortSecrets(secrets: SecretRecord[]): SecretRecord[] {
  return [...secrets].sort((left, right) => left.name.localeCompare(right.name));
}

function cloneSecrets(secrets: SecretRecord[]): SecretRecord[] {
  return secrets.map((secret) => ({ ...secret }));
}

export class SecretRegistry {
  private readonly withLock = createAsyncLock();
  private cachedState: SecretRegistryFile | null = null;
  private cachedSortedValues: string[] | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<SecretRecord[]> {
    const state = await this.readFile();
    return cloneSecrets(state.secrets);
  }

  async list(): Promise<SecretListItem[]> {
    const secrets = await this.load();
    return secrets.map((secret) => ({
      name: secret.name,
      length: secret.value.length,
      digest: summarizeSecret(secret.value),
    }));
  }

  async sortedValues(): Promise<string[]> {
    if (this.cachedSortedValues) {
      return [...this.cachedSortedValues];
    }
    const values = [...new Set((await this.load()).map((secret) => secret.value))].sort((left, right) => {
      if (left.length !== right.length) {
        return right.length - left.length;
      }
      return left.localeCompare(right);
    });
    this.cachedSortedValues = values;
    return [...values];
  }

  async add(name: string, value: string): Promise<SecretRecord> {
    return await this.withLock(async () => {
      const normalizedName = assertSecretName(name);
      const secretValue = assertSecretValue(value);
      const state = await this.readFile();
      if (state.secrets.some((secret) => secret.name === normalizedName)) {
        throw new Error(`secret already exists: ${normalizedName}`);
      }
      const nextSecret = { name: normalizedName, value: secretValue };
      state.secrets.push(nextSecret);
      await this.writeFile(state);
      return nextSecret;
    });
  }

  async update(name: string, value: string): Promise<SecretRecord> {
    return await this.withLock(async () => {
      const normalizedName = assertSecretName(name);
      const secretValue = assertSecretValue(value);
      const state = await this.readFile();
      const existing = state.secrets.find((secret) => secret.name === normalizedName);
      if (!existing) {
        throw new Error(`secret not found: ${normalizedName}`);
      }
      existing.value = secretValue;
      await this.writeFile(state);
      return { name: existing.name, value: existing.value };
    });
  }

  async remove(name: string): Promise<boolean> {
    return await this.withLock(async () => {
      const normalizedName = assertSecretName(name);
      const state = await this.readFile();
      const nextSecrets = state.secrets.filter((secret) => secret.name !== normalizedName);
      if (nextSecrets.length === state.secrets.length) {
        return false;
      }
      await this.writeFile({ version: 1, secrets: nextSecrets });
      return true;
    });
  }

  private async readFile(): Promise<SecretRegistryFile> {
    if (this.cachedState) {
      return { version: 1, secrets: cloneSecrets(this.cachedState.secrets) };
    }
    const parsed = await readJsonFile(this.filePath);
    const nextState = !isSecretRegistryFile(parsed)
      ? { ...EMPTY_SECRET_REGISTRY, secrets: [] }
      : {
          version: 1 as const,
          secrets: sortSecrets(
            parsed.secrets.map((secret) => ({
              name: assertSecretName(secret.name),
              value: assertSecretValue(secret.value),
            })),
          ),
        };
    this.cachedState = { version: 1, secrets: cloneSecrets(nextState.secrets) };
    return { version: 1, secrets: cloneSecrets(nextState.secrets) };
  }

  private async writeFile(state: SecretRegistryFile): Promise<void> {
    const nextState = { version: 1 as const, secrets: sortSecrets(state.secrets) };
    this.cachedState = { version: 1, secrets: cloneSecrets(nextState.secrets) };
    this.cachedSortedValues = null;
    await writeJsonFileAtomic(this.filePath, nextState);
  }
}
