import fs from "node:fs";
import path from "node:path";

type Logger = { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };

const PLACEHOLDER_PATTERN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
const PLACEHOLDER_EDGE_PATTERN = /^\{\{|\}\}$/g;
const MIN_REDACTION_LENGTH = 4;
const VAULT_MARKER_RE = /<<VAULT:([A-Z_][A-Z0-9_]*)=([\s\S]+?)>>/g;

export function normalizeSecretName(name: string): string {
  return name.replace(PLACEHOLDER_EDGE_PATTERN, "").toUpperCase();
}

export function formatPlaceholder(name: string): string {
  return `{{${normalizeSecretName(name)}}}`;
}

export class SecretStore {
  private secrets: Map<string, string> = new Map();
  private redactionEntries: Array<[string, string]> = [];
  private filePath: string;
  private logger: Logger;

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string") this.secrets.set(normalizeSecretName(k), v);
        }
        this.rebuildIndexes();
        this.logger.info?.(`secret-placeholder: loaded ${this.secrets.size} secret(s)`);
      }
    } catch (err) {
      this.logger.warn?.(`secret-placeholder: failed to load secrets file`, err);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data: Record<string, string> = {};
    for (const [k, v] of this.secrets) data[k] = v;
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get size(): number {
    return this.secrets.size;
  }

  set(name: string, value: string): void {
    this.secrets.set(normalizeSecretName(name), value);
    this.rebuildIndexes();
    this.save();
  }

  get(name: string): string | undefined {
    return this.secrets.get(normalizeSecretName(name));
  }

  delete(name: string): boolean {
    const deleted = this.secrets.delete(normalizeSecretName(name));
    if (deleted) {
      this.rebuildIndexes();
      this.save();
    }
    return deleted;
  }

  clear(): void {
    this.secrets.clear();
    this.rebuildIndexes();
    this.save();
  }

  batchSet(entries: Array<{ name: string; value: string }>): void {
    if (entries.length === 0) return;
    for (const { name, value } of entries) {
      this.secrets.set(normalizeSecretName(name), value);
    }
    this.rebuildIndexes();
    this.save();
  }

  extractVaultMarkers(text: string): { cleaned: string; entries: Array<{ name: string; value: string }> } {
    const entries: Array<{ name: string; value: string }> = [];
    const cleaned = text.replace(VAULT_MARKER_RE, (_match, name: string, value: string) => {
      entries.push({ name: normalizeSecretName(name), value });
      return "";
    });
    return { cleaned, entries };
  }

  listNames(): string[] {
    return [...this.secrets.keys()].sort();
  }

  redact(text: string): string {
    if (this.redactionEntries.length === 0) return text;

    let result = text;
    for (const [name, value] of this.redactionEntries) {
      result = result.split(value).join(formatPlaceholder(name));
    }
    return result;
  }

  substitute(text: string): string {
    if (this.secrets.size === 0) return text;
    return text.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      const value = this.secrets.get(normalizeSecretName(name));
      return value !== undefined ? value : match;
    });
  }

  deepSubstitute<T>(value: T): { result: T; changed: boolean } {
    if (this.secrets.size === 0) return { result: value, changed: false };
    return this.deepTransform(value, (text) => this.substitute(text));
  }

  deepRedact<T>(value: T): { result: T; changed: boolean } {
    if (this.secrets.size === 0) return { result: value, changed: false };
    return this.deepTransform(value, (text) => this.redact(text));
  }

  private rebuildIndexes(): void {
    this.redactionEntries = [...this.secrets.entries()]
      .filter(([, value]) => value.length >= MIN_REDACTION_LENGTH)
      .sort((a, b) => b[1].length - a[1].length);
  }

  private deepTransform<T>(value: T, transform: (text: string) => string): { result: T; changed: boolean } {
    if (typeof value === "string") {
      const transformed = transform(value);
      return { result: transformed as T, changed: transformed !== value };
    }

    if (Array.isArray(value)) {
      let anyChanged = false;
      const arrayResult = value.map((item) => {
        const { result, changed } = this.deepTransform(item, transform);
        if (changed) anyChanged = true;
        return result;
      });
      return { result: (anyChanged ? arrayResult : value) as T, changed: anyChanged };
    }

    if (value !== null && typeof value === "object") {
      let anyChanged = false;
      const objectResult: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        const { result, changed } = this.deepTransform(nestedValue, transform);
        objectResult[key] = result;
        if (changed) anyChanged = true;
      }
      return { result: (anyChanged ? objectResult : value) as T, changed: anyChanged };
    }

    return { result: value, changed: false };
  }
}
