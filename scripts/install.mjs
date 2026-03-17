#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "openclaw-vault";
const DEFAULT_REPO = "dayhi/openclaw-vault";
const DEFAULT_PLUGIN_SUBDIR = ".";

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function normalizePluginSubdir(pluginSubdir) {
  const segments = pluginSubdir
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");

  return segments.length === 0 ? "." : segments.join("/");
}

function parseArgs(argv) {
  const options = {
    archiveUrl: process.env.OPENCLAW_VAULT_ARCHIVE_URL || null,
    pluginSubdir: DEFAULT_PLUGIN_SUBDIR,
    repo: process.env.OPENCLAW_VAULT_REPO || DEFAULT_REPO,
    ref: process.env.OPENCLAW_VAULT_REF || null,
    restartGateway: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--archive-url") {
      options.archiveUrl = readOptionValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--plugin-subdir") {
      options.pluginSubdir = readOptionValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = readOptionValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      options.ref = readOptionValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--no-restart") {
      options.restartGateway = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.pluginSubdir || (!options.archiveUrl && !options.repo)) {
    throw new Error("Missing install source options.");
  }

  options.pluginSubdir = normalizePluginSubdir(options.pluginSubdir);
  return options;
}

function isWindows() {
  return process.platform === "win32";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      env: options.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";

    if (options.capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const error = new Error(
        [`Command failed: ${command} ${args.join(" ")}`, stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n"),
      );
      reject(error);
    });
  });
}

async function commandExists(command) {
  try {
    const probe = isWindows() ? ["/c", "where", command] : ["-c", `command -v ${shellQuote(command)}`];
    await execCommand(isWindows() ? "cmd.exe" : "sh", probe, { capture: true });
    return true;
  } catch {
    return false;
  }
}

async function readJsonCommand(command, args) {
  const result = await execCommand(command, args, { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${command} ${args.join(" ")}: ${result.stdout || result.stderr}`);
  }
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "openclaw-vault-installer",
        },
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = chunks.join("");
          let payload = null;

          if (body) {
            try {
              payload = JSON.parse(body);
            } catch {
              reject(new Error(`Failed to parse JSON from ${url}: ${body}`));
              return;
            }
          }

          resolve({
            statusCode: response.statusCode ?? 0,
            payload,
          });
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Request timed out: ${url}`));
    });
  });
}

function buildArchiveUrl(repo, ref) {
  return `https://github.com/${repo}/archive/${ref}.tar.gz`;
}

async function resolveLatestReleaseTag(repo) {
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await requestJson(releaseUrl);

  if (response.statusCode === 404) {
    throw new Error(
      `No GitHub release found for ${repo}. Publish the first release before using the default installer, or install unpublished code explicitly with --ref main.`,
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const details = response.payload?.message ? ` ${response.payload.message}` : "";
    throw new Error(`Failed to resolve latest release for ${repo} (HTTP ${response.statusCode}).${details}`);
  }

  const tag = response.payload?.tag_name;
  if (!tag) {
    throw new Error(`Latest release response for ${repo} did not include tag_name.`);
  }

  return tag;
}

async function resolveInstallSource(options) {
  if (options.archiveUrl) {
    return {
      archiveUrl: options.archiveUrl,
      repo: null,
      ref: null,
      sourceType: "archive-url",
    };
  }

  if (options.ref) {
    return {
      archiveUrl: buildArchiveUrl(options.repo, options.ref),
      repo: options.repo,
      ref: options.ref,
      sourceType: "ref",
    };
  }

  const releaseTag = await resolveLatestReleaseTag(options.repo);
  return {
    archiveUrl: buildArchiveUrl(options.repo, releaseTag),
    repo: options.repo,
    ref: releaseTag,
    sourceType: "latest-release",
  };
}

function logInstallSource(options, source) {
  if (source.sourceType === "latest-release") {
    console.log(`[vault] Install source: latest release`);
  } else if (source.sourceType === "ref") {
    console.log(`[vault] Install source: explicit ref/tag`);
  } else {
    console.log(`[vault] Install source: explicit archive URL`);
  }

  console.log(`[vault] Repository: ${source.repo ?? "(custom archive URL)"}`);
  console.log(`[vault] Ref/tag: ${source.ref ?? "(custom archive URL)"}`);
  console.log(`[vault] Archive URL: ${source.archiveUrl}`);
  console.log(`[vault] Plugin subdir: ${options.pluginSubdir}`);
}

async function detectExistingInstallPath() {
  try {
    const payload = await readJsonCommand("openclaw", ["plugins", "list", "--json"]);
    const plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
    const plugin = plugins.find((entry) => entry && entry.id === PLUGIN_ID);
    if (!plugin) {
      return null;
    }

    try {
      const info = await execCommand("openclaw", ["plugins", "info", PLUGIN_ID], { capture: true });
      const match = info.stdout.match(/Install path:\s+(.+)$/m);
      return match?.[1]?.trim() || null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function uninstallExistingInstall() {
  const installPath = await detectExistingInstallPath();
  if (!installPath) {
    return false;
  }
  console.log(`[vault] Removing existing install: ${installPath}`);
  await execCommand("openclaw", ["plugins", "uninstall", PLUGIN_ID, "--force"]);
  return true;
}

async function downloadArchive(outputPath, url) {
  if (await commandExists("curl")) {
    await execCommand("curl", ["-fsSL", url, "-o", outputPath]);
    return;
  }

  if (await commandExists("powershell")) {
    await execCommand("powershell", [
      "-NoProfile",
      "-Command",
      `Invoke-WebRequest -UseBasicParsing -Uri ${JSON.stringify(url)} -OutFile ${JSON.stringify(outputPath)}`,
    ]);
    return;
  }

  throw new Error("Neither curl nor PowerShell is available for downloading the archive.");
}

async function resolveTarCommand() {
  if (isWindows()) {
    const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    try {
      await access(systemTar, fsConstants.F_OK);
      return systemTar;
    } catch {
    }
  }

  if (!(await commandExists("tar"))) {
    throw new Error("tar is required to extract the downloaded archive.");
  }
  return "tar";
}

async function extractTarGz(archivePath, destinationDir) {
  const tarCommand = await resolveTarCommand();
  await execCommand(tarCommand, ["-xzf", archivePath, "-C", destinationDir]);
}

async function directoryContainsPluginManifest(directory) {
  try {
    await access(path.join(directory, "openclaw.plugin.json"), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findPluginDir(rootDir, pluginSubdir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const relativeSegments = pluginSubdir === "." ? [] : pluginSubdir.split("/");

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(rootDir, entry.name, ...relativeSegments);
    if (await directoryContainsPluginManifest(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not locate plugin directory "${pluginSubdir}" in extracted archive.`);
}

async function maybeRestartGateway() {
  try {
    await execCommand("openclaw", ["gateway", "restart"]);
    console.log("[vault] Gateway restarted.");
    return true;
  } catch (error) {
    console.warn(`[vault] Gateway restart failed: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("[vault] Please restart the OpenClaw Gateway manually.");
    return false;
  }
}

async function runVaultSetup() {
  const setup = await execCommand("openclaw", ["vault", "setup", "--json"], { capture: true });
  let payload;
  try {
    payload = JSON.parse(setup.stdout);
  } catch {
    throw new Error(`Vault setup returned invalid JSON:\n${setup.stdout || setup.stderr}`);
  }

  console.log(payload.text);
  return payload;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!(await commandExists("node"))) {
    throw new Error("Node.js is required.");
  }
  if (!(await commandExists("openclaw"))) {
    throw new Error("OpenClaw CLI is required. Please install/configure OpenClaw first.");
  }

  const installSource = await resolveInstallSource(options);
  logInstallSource(options, installSource);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-vault-install-"));
  const archivePath = path.join(tempDir, "openclaw-vault.tar.gz");

  try {
    console.log(`[vault] Downloading ${installSource.archiveUrl}`);
    await downloadArchive(archivePath, installSource.archiveUrl);

    console.log("[vault] Extracting archive");
    await extractTarGz(archivePath, tempDir);

    const pluginDir = await findPluginDir(tempDir, options.pluginSubdir);
    if (!pluginDir) {
      throw new Error(`Could not locate plugin directory "${options.pluginSubdir}" in downloaded archive.`);
    }

    await uninstallExistingInstall();

    console.log(`[vault] Installing plugin from ${pluginDir}`);
    await execCommand("openclaw", ["plugins", "install", pluginDir]);

    console.log("[vault] Running Vault setup");
    const setupResult = await runVaultSetup();

    if (options.restartGateway) {
      const restarted = await maybeRestartGateway();
      if (restarted && setupResult?.configChanged) {
        console.log("[vault] Re-applying restart after config changes");
        await maybeRestartGateway();
      }
    }

    console.log("[vault] Install completed.");
    console.log("[vault] You can now use /s check, /s add, /s list, and inline <<s:...>> secrets.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[vault] Install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
