import { run } from "./process.js";

/** Resolve the repository's current Git attributes, including nested overrides. */
export function generatedFiles(repo: string, paths: Iterable<string>): Set<string> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Set();
  const fields = run("git", ["check-attr", "-z", "--stdin", "linguist-generated"], {
    cwd: repo,
    input: `${unique.join("\0")}\0`,
  }).stdout.toString("utf8").split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    // Linguist treats any specified value other than false as enabled.
    if (!["unspecified", "unset", "false"].includes(fields[index + 2])) generated.add(fields[index]);
  }
  return generated;
}
