#!/usr/bin/env node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PLUGIN_ID = "openclaw-vault";
const DEFAULT_REPO = "openclaw/openclaw";
const DEFAULT_REF = "main";
const RELEASE_REPO = process.env.OPENCLAW_VAULT_REPO || DEFAULT_REPO;
const RELEASE_REF = process.env.OPENCLAW_VAULT_REF || DEFAULT_REF;
const ARCHIVE_URL =
  process.env.OPENCLAW_VAULT_ARCHIVE_URL ||
  `https://github.com/${RELEASE_REPO}/archive/${RELEASE_REF}.tar.gz`;
const PLUGIN_SUBDIR = "extensions/openclaw-vault";

function parseArgs(argv) {
  const options = {
    archiveUrl: ARCHIVE_URL,
    pluginSubdir: PLUGIN_SUBDIR,
    repo: RELEASE_REPO,
    ref: RELEASE_REF,
    restartGateway: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--archive-url") {
      options.archiveUrl = argv[++index];
      continue;
    }
    if (arg === "--plugin-subdir") {
      options.pluginSubdir = argv[++index];
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[++index];
      continue;
    }
    if (arg === "--ref") {
      options.ref = argv[++index];
      continue;
    }
    if (arg === "--no-restart") {
      options.restartGateway = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.archiveUrl || !options.pluginSubdir) {
    throw new Error("Missing install source options.");
  }

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

async function extractTarGz(archivePath, destinationDir) {
  if (!(await commandExists("tar"))) {
    throw new Error("tar is required to extract the downloaded archive.");
  }
  await execCommand("tar", ["-xzf", archivePath, "-C", destinationDir]);
}

async function findPluginDir(rootDir, pluginSubdir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(rootDir, entry.name, ...pluginSubdir.split("/"));
    try {
      const nested = await readdir(candidate);
      if (nested.length >= 0) {
        return candidate;
      }
    } catch {
    }
  }
  throw new Error(`Could not locate plugin directory \"${pluginSubdir}\" in extracted archive.`);
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

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-vault-install-"));
  const archivePath = path.join(tempDir, "openclaw-vault.tar.gz");

  try {
    console.log(`[vault] Downloading ${options.archiveUrl}`);
    await downloadArchive(archivePath, options.archiveUrl);

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
