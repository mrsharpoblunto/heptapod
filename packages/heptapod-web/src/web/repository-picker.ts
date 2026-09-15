import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function pickRepositoryDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("The native repository picker is currently available on macOS.");
  try {
    const { stdout } = await execute("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a Git repository")'], {
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch (error) {
    const message = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    if (/User canceled|-128/.test(message)) return null;
    throw new Error("Could not open the repository folder picker.");
  }
}
