import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Jobs lead their own process groups, including synchronous Git/test subprocesses.
export async function cancelProcess(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (!child.pid) { await exited; return; }
  if (process.platform === "win32") {
    try { await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"]); }
    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
  } else {
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-child.pid!, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    // Kill surviving descendants even if the job itself already exited.
    await delay(250);
    signal("SIGKILL");
  }
  await exited;
}
