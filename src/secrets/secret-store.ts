import fs from "node:fs";
import path from "node:path";

type Logger = { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };

export class SecretStore {
  private secrets: Map<string, string> = new Map();
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
          if (typeof v === "string") this.secrets.set(k, v);
        }
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
    this.secrets.set(name.toUpperCase(), value);
    this.save();
  }

  get(name: string): string | undefined {
    return this.secrets.get(name.toUpperCase());
  }

  delete(name: string): boolean {
    const deleted = this.secrets.delete(name.toUpperCase());
    if (deleted) this.save();
    return deleted;
  }

  clear(): void {
    this.secrets.clear();
    this.save();
  }

  listNames(): string[] {
    return [...this.secrets.keys()].sort();
  }

  /** Replace real secret values in text with {{NAME}} placeholders. */
  redact(text: string): string {
    if (this.secrets.size === 0) return text;
    // Sort by value length descending to avoid substring false matches
    const entries = [...this.secrets.entries()]
      .filter(([, v]) => v.length >= 4)
      .sort((a, b) => b[1].length - a[1].length);
    let result = text;
    for (const [name, value] of entries) {
      // Use split+join for safe literal replacement (no regex special chars issue)
      result = result.split(value).join(`{{${name}}}`);
    }
    return result;
  }

  /** Replace {{NAME}} placeholders in text with real values. */
  substitute(text: string): string {
    if (this.secrets.size === 0) return text;
    return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, name: string) => {
      const value = this.secrets.get(name);
      return value !== undefined ? value : match;
    });
  }

  /** Recursively substitute {{NAME}} placeholders in all string values of an object/array. */
  deepSubstitute<T>(value: T): { result: T; changed: boolean } {
    if (this.secrets.size === 0) return { result: value, changed: false };
    return this._deepSub(value);
  }

  private _deepSub<T>(value: T): { result: T; changed: boolean } {
    if (typeof value === "string") {
      const substituted = this.substitute(value);
      return { result: substituted as T, changed: substituted !== value };
    }
    if (Array.isArray(value)) {
      let anyChanged = false;
      const arr = value.map((item) => {
        const { result, changed } = this._deepSub(item);
        if (changed) anyChanged = true;
        return result;
      });
      return { result: (anyChanged ? arr : value) as T, changed: anyChanged };
    }
    if (value !== null && typeof value === "object") {
      let anyChanged = false;
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const { result, changed } = this._deepSub(v);
        obj[k] = result;
        if (changed) anyChanged = true;
      }
      return { result: (anyChanged ? obj : value) as T, changed: anyChanged };
    }
    return { result: value, changed: false };
  }
}
