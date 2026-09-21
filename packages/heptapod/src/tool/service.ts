import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeptapodStateDirectory } from "@thestraylight/heptapod-core/repositories";
import { resolveServiceConfigPath, serviceApiUrl, serviceWebUrl, writeServiceConfig } from "@thestraylight/heptapod-core/service-config";
import { apiUrl, checkService } from "./client.js";

function files() {
  const state = resolveHeptapodStateDirectory();
  return { state, pid: join(state, "service.pid"), log: join(state, "service.log") };
}

function launcher(): string {
  return fileURLToPath(import.meta.resolve("@thestraylight/heptapod-web/launcher"));
}

function recordedPid(): number | null {
  try {
    const pid = Number(readFileSync(files().pid, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

function launchdPid(): number | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/com.thestraylight.heptapod`], { encoding: "utf8" });
  const match = result.status === 0 ? result.stdout.match(/^\s*pid = (\d+)$/m) : null;
  return match ? Number(match[1]) : null;
}

const systemdUnit = "heptapod.service";

function systemdPath(): string {
  const config = process.env.XDG_CONFIG_HOME;
  return join(config && isAbsolute(config) ? config : join(homedir(), ".config"), "systemd", "user", systemdUnit);
}

function systemctl(...args: string[]): void {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim();
    throw new Error(`systemctl --user ${args.join(" ")} failed${detail ? `: ${detail}` : "."} Linux service installation requires systemd and a running user manager. Use \`heptapod service run\` otherwise.`);
  }
}

function systemdPid(): number | null {
  if (process.platform !== "linux") return null;
  const result = spawnSync("systemctl", ["--user", "show", systemdUnit, "--property=MainPID", "--value"], { encoding: "utf8" });
  const pid = result.status === 0 ? Number(result.stdout.trim()) : 0;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function serviceStatus(base = apiUrl()): Promise<{ running: boolean; pid: number | null; url: string }> {
  const pid = recordedPid() ?? launchdPid() ?? systemdPid();
  try { await checkService(base); return { running: true, pid, url: base }; }
  catch { return { running: false, pid, url: base }; }
}

export function configureService(port: number) {
  const config = writeServiceConfig(port);
  return { ...config, configPath: resolveServiceConfigPath(), webUrl: serviceWebUrl(config), apiUrl: serviceApiUrl(config) };
}

export function runService(): Promise<void> {
  const child = spawn(process.execPath, [launcher()], { stdio: "inherit", env: process.env });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { process.exitCode = code ?? 1; resolve(); });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
  });
}

export async function startService(base = apiUrl()): Promise<{ running: true; pid: number; url: string }> {
  const current = await serviceStatus(base);
  if (current.running) return { running: true, pid: current.pid ?? 0, url: base };
  const { state, pid, log } = files();
  if (process.platform === "linux" && existsSync(systemdPath())) {
    systemctl("start", systemdUnit);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await serviceStatus(base);
      if (status.running) return { running: true, pid: status.pid ?? 0, url: base };
    }
    throw new Error(`Heptapod did not start. Inspect \`journalctl --user -u ${systemdUnit}\`.`);
  }
  mkdirSync(state, { recursive: true });
  const descriptor = openSync(log, "a");
  const child = spawn(process.execPath, [launcher()], { detached: true, stdio: ["ignore", descriptor, descriptor], env: process.env });
  closeSync(descriptor);
  if (!child.pid) throw new Error("Could not start the Heptapod service.");
  writeFileSync(pid, String(child.pid), { mode: 0o600 });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await serviceStatus(base)).running) return { running: true, pid: child.pid, url: base };
  }
  throw new Error(`Heptapod did not start. Inspect ${log}.`);
}

export function stopService(): boolean {
  const { pid } = files();
  if (process.platform === "linux" && existsSync(systemdPath())) {
    systemctl("stop", systemdUnit);
    if (existsSync(pid)) unlinkSync(pid);
    return true;
  }
  if (process.platform === "darwin") {
    const stopped = spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/com.thestraylight.heptapod`], { encoding: "utf8" });
    if (stopped.status === 0) { if (existsSync(pid)) unlinkSync(pid); return true; }
  }
  const running = recordedPid();
  if (!running) { if (existsSync(pid)) unlinkSync(pid); return false; }
  process.kill(running, "SIGTERM");
  unlinkSync(pid);
  return true;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  // Unit values use C-style escaping and expand % specifiers, even inside quotes.
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t").replaceAll("%", "%%")}"`;
}

function installSystemdService(): string {
  const path = systemdPath();
  const { state } = files();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(state, { recursive: true });
  // The ':' executable prefix disables $ expansion in the command's paths.
  const command = [`:${process.execPath}`, launcher()].map(systemdQuote).join(" ");
  writeFileSync(path, `[Unit]
Description=Heptapod review service

[Service]
Type=simple
ExecStart=${command}
Environment=${systemdQuote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}
Environment=${systemdQuote(`HEPTAPOD_STATE_DIR=${state}`)}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`, { mode: 0o600 });
  systemctl("daemon-reload");
  systemctl("enable", systemdUnit);
  // Restart also applies updated paths and environment when installing again.
  systemctl("restart", systemdUnit);
  return path;
}

export function installService(): string {
  if (process.platform === "linux") return installSystemdService();
  if (process.platform !== "darwin") throw new Error("Automatic service installation supports macOS and Linux with systemd. Use `heptapod service run` with your user service manager.");
  const path = join(homedir(), "Library", "LaunchAgents", "com.thestraylight.heptapod.plist");
  mkdirSync(dirname(path), { recursive: true });
  const serviceFiles = files();
  mkdirSync(serviceFiles.state, { recursive: true });
  const log = serviceFiles.log;
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.thestraylight.heptapod</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(launcher())}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`, { mode: 0o600 });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/com.thestraylight.heptapod`], { encoding: "utf8" });
  let loaded = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, path], { encoding: "utf8" });
  // launchd can briefly retain a job after bootout and report EIO on an immediate bootstrap.
  for (let attempt = 0; loaded.status !== 0 && attempt < 20; attempt += 1) {
    spawnSync("/bin/sleep", ["0.1"]);
    loaded = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, path], { encoding: "utf8" });
  }
  if (loaded.status !== 0 && !/already loaded|service already loaded/i.test(loaded.stderr)) {
    throw new Error(loaded.stderr.trim() || "launchctl could not install the Heptapod service.");
  }
  return path;
}
