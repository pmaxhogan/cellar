#!/usr/bin/env node
/**
 * Fails when any tracked text file matches a private pattern. The patterns are
 * deliberately NOT in this repository: they come from the PRIVATE_PATTERNS
 * environment variable (one regular expression per line; a GitHub Actions
 * secret in CI) or from the file named by PRIVATE_PATTERNS_FILE (default
 * ~/.config/cellar/private-patterns.txt). With neither configured the check
 * prints a notice and passes, so a fresh clone is never blocked by it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadPatterns() {
  let text = process.env.PRIVATE_PATTERNS ?? "";
  if (text.trim() === "") {
    const file =
      process.env.PRIVATE_PATTERNS_FILE ??
      join(homedir(), ".config", "cellar", "private-patterns.txt");
    if (existsSync(file)) {
      text = readFileSync(file, "utf8");
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return new RegExp(line, "i");
      } catch {
        // Never print the pattern or the engine's message: both would leak it.
        console.error(`check-private: pattern #${index + 1} does not compile`);
        process.exit(1);
      }
    });
}

const patterns = loadPatterns();
if (patterns.length === 0) {
  // Fail closed where the secret is expected (a push to the default branch in
  // Actions). Pull requests from forks and Dependabot cannot read secrets, so
  // there the check is informational and the push-to-main run is the gate.
  const mustHavePatterns =
    process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "push";
  if (mustHavePatterns) {
    console.error("check-private: PRIVATE_PATTERNS is not configured for this push run");
    process.exit(1);
  }
  console.log("check-private: no patterns configured, skipping");
  process.exit(0);
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz|gz|jar)$/i.test(f));

let hits = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        hits += 1;
        // Print the location only, never the matching text.
        console.error(`check-private: ${file}:${index + 1} matches a private pattern`);
        break;
      }
    }
  });
}

if (hits > 0) {
  console.error(`check-private: ${hits} line(s) contain private setup details`);
  process.exit(1);
}
console.log(`check-private: ok (${files.length} files, ${patterns.length} patterns)`);
