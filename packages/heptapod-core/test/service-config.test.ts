import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DEFAULT_SERVICE_PORT, readServiceConfig, resolveServiceConfigPath, serviceApiUrl, serviceWebUrl, writeServiceConfig } from "../src/tool/service-config.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("uses a dedicated default port and shares a validated per-user override", () => {
  const state = mkdtempSync(join(tmpdir(), "heptapod-service-config-")); directories.push(state); vi.stubEnv("HEPTAPOD_STATE_DIR", state);
  assert.deepEqual(readServiceConfig(), { port: DEFAULT_SERVICE_PORT });
  assert.equal(serviceWebUrl(), `http://localhost:${DEFAULT_SERVICE_PORT}`);
  assert.equal(serviceApiUrl(), `http://localhost:${DEFAULT_SERVICE_PORT}/api/service`);
  assert.deepEqual(writeServiceConfig(51_234), { port: 51_234 });
  assert.deepEqual(readServiceConfig(), { port: 51_234 });
  writeFileSync(resolveServiceConfigPath(), JSON.stringify({ port: 65_536 }));
  assert.throws(() => readServiceConfig(), /port must be an integer/);
});
