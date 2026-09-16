import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("the published CLI starts using only its packaged runtime files", () => {
  const temporary = mkdtempSync(join(tmpdir(), "heptapod-package-"));
  try {
    // The test script builds first; skip prepack to avoid a nested build.
    const output = execFileSync("npm", [
      "pack", "--ignore-scripts", "--json",
      "--pack-destination", temporary, "--cache", join(temporary, "npm-cache"),
    ], { cwd: packageRoot, encoding: "utf8" });
    const [packed] = JSON.parse(output);
    execFileSync("tar", ["-xzf", join(temporary, packed.filename), "-C", temporary]);
    const installed = join(temporary, "package");
    assert.equal(existsSync(join(installed, "src")), false);

    // Reuse installed dependencies without exposing the checkout's dist files.
    symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "junction");
    const result = spawnSync(process.execPath, [join(installed, "scripts/heptapod.mjs"), "--help"], {
      cwd: temporary,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /heptapod service install/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
