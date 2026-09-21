import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { installService, serviceStatus, startService, stopService } from "../dist/tool/service.js";

function fixture(t, platform = "linux") {
  const temporary = mkdtempSync(join(os.tmpdir(), "heptapod-service-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const env = { ...process.env };
  Object.defineProperty(process, "platform", { value: platform });
  process.env.XDG_CONFIG_HOME = join(temporary, "config");
  process.env.HEPTAPOD_STATE_DIR = join(temporary, "state");
  t.mock.method(os, "homedir", () => temporary);
  const calls = [];
  let result = () => ({ status: 0, stdout: "", stderr: "" });
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    calls.push([command, ...args]);
    return result(command, args);
  });
  // Prevent a regression from starting a real server during these tests.
  t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected unmanaged process"); });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(temporary, { recursive: true, force: true });
  });
  return {
    temporary, calls,
    path: join(process.env.XDG_CONFIG_HOME, "systemd", "user", "heptapod.service"),
    reply: (callback) => { result = callback; },
  };
}

test("Linux installation enables and starts a user service, including on reinstall", (t) => {
  const { calls, path } = fixture(t);
  assert.equal(installService(), path);
  const unit = readFileSync(path, "utf8");
  assert.ok(unit.includes(`ExecStart=":${process.execPath}" "`));
  assert.match(unit, /heptapod-web\.mjs"\n/);
  assert.ok(unit.includes(`Environment="HEPTAPOD_STATE_DIR=${process.env.HEPTAPOD_STATE_DIR}"`));
  assert.match(unit, /Restart=always\nRestartSec=5/);
  assert.match(unit, /StandardOutput=journal\nStandardError=journal/);
  assert.match(unit, /\[Install\]\nWantedBy=default.target/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const expected = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "heptapod.service"],
    ["systemctl", "--user", "restart", "heptapod.service"],
  ];
  assert.deepEqual(calls, expected);
  process.env.PATH = "/new/node/bin:/usr/bin";
  assert.equal(installService(), path);
  assert.match(readFileSync(path, "utf8"), /Environment="PATH=\/new\/node\/bin:\/usr\/bin"/);
  assert.deepEqual(calls, [...expected, ...expected]);
});

test("Linux unit values escape quotes, backslashes, specifiers and line breaks", (t) => {
  const { path } = fixture(t);
  process.env.PATH = '/tools with spaces/"quoted"/back\\slash/%h/$HOME:\n/usr/bin';
  const executable = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", { value: '/node path/%h/${HOME}/"node"' });
  t.after(() => Object.defineProperty(process, "execPath", executable));
  installService();
  const unit = readFileSync(path, "utf8");
  assert.ok(unit.includes('Environment="PATH=/tools with spaces/\\"quoted\\"/back\\\\slash/%%h/$HOME:\\n/usr/bin"\n'));
  assert.ok(unit.includes('ExecStart=":/node path/%%h/${HOME}/\\"node\\"" "'));
});

test("Linux installation uses the default config and XDG state directories", (t) => {
  const { temporary } = fixture(t);
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.HEPTAPOD_STATE_DIR;
  process.env.XDG_STATE_HOME = join(temporary, "custom state");
  const path = join(temporary, ".config", "systemd", "user", "heptapod.service");
  assert.equal(installService(), path);
  assert.ok(readFileSync(path, "utf8").includes(`Environment="HEPTAPOD_STATE_DIR=${temporary}/custom state/heptapod"`));
  process.env.XDG_CONFIG_HOME = "relative-config-is-invalid";
  assert.equal(installService(), path);
});

for (const action of ["daemon-reload", "enable", "restart"]) {
  test(`Linux installation reports ${action} failures`, (t) => {
    const { calls, reply } = fixture(t);
    reply((_command, args) => ({ status: args[1] === action ? 1 : 0, stdout: "", stderr: "User manager unavailable" }));
    assert.throws(installService, /User manager unavailable.*heptapod service run/);
    assert.equal(calls.at(-1)[2], action);
  });
}

test("Linux installation explains missing systemctl", (t) => {
  const { reply } = fixture(t);
  reply(() => ({ status: null, stdout: null, stderr: null, error: new Error("spawnSync systemctl ENOENT") }));
  assert.throws(installService, /systemctl ENOENT.*requires systemd.*heptapod service run/);
});

test("Linux start, status and stop control the installed unit", async (t) => {
  const { path, calls, reply } = fixture(t);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "[Service]\n");
  let running = false;
  reply((_command, args) => {
    if (args[1] === "start") running = true;
    if (args[1] === "stop") running = false;
    return { status: 0, stdout: running ? "12345\n" : "0\n", stderr: "" };
  });
  t.mock.method(globalThis, "fetch", async () => {
    if (!running) throw new Error("Connection refused");
    return Response.json({ ready: true, ingestionProtocolVersion: 1, reviewPayloadSchemaVersion: 1 });
  });
  const url = "http://localhost:49731/api/service";
  assert.deepEqual(await serviceStatus(url), { running: false, pid: null, url });
  assert.deepEqual(await startService(url), { running: true, pid: 12345, url });
  assert.deepEqual(await serviceStatus(url), { running: true, pid: 12345, url });
  assert.deepEqual(await startService(url), { running: true, pid: 12345, url });
  assert.equal(calls.filter((call) => call[2] === "start").length, 1);
  assert.equal(stopService(), true);
  assert.deepEqual(await serviceStatus(url), { running: false, pid: null, url });
  assert.ok(calls.some((call) => call[2] === "stop"));
  assert.equal(existsSync(join(process.env.HEPTAPOD_STATE_DIR, "service.pid")), false);
});

test("Linux start and stop expose manager failures without spawning an unmanaged server", async (t) => {
  const { path, reply } = fixture(t);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "[Service]\n");
  reply(() => ({ status: 1, stdout: "", stderr: "Cannot connect to user bus" }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Connection refused"); });
  await assert.rejects(startService(), /Cannot connect to user bus/);
  assert.throws(stopService, /Cannot connect to user bus/);
});

test("Linux status and stop work without systemd or an installed service", async (t) => {
  const { reply } = fixture(t);
  reply(() => ({ status: null, stdout: null, stderr: null, error: new Error("ENOENT") }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Connection refused"); });
  const status = await serviceStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(stopService(), false);
});

test("macOS installation still writes and loads a LaunchAgent", (t) => {
  const { temporary, calls } = fixture(t, "darwin");
  const path = installService();
  assert.equal(path, join(temporary, "Library", "LaunchAgents", "com.thestraylight.heptapod.plist"));
  assert.match(readFileSync(path, "utf8"), /<key>KeepAlive<\/key><true\/>/);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [["launchctl", "bootout"], ["launchctl", "bootstrap"]]);
});

test("unsupported platforms retain the manual service alternative", (t) => {
  const { calls } = fixture(t, "freebsd");
  assert.throws(installService, /macOS and Linux with systemd.*heptapod service run/);
  assert.deepEqual(calls, []);
});
