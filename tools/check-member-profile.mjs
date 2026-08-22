// check-member-profile — runs tools/member-checks/check.mjs from the suite.
//
// ⚠ WHY A WRAPPER EXISTS AT ALL. The real file needs
// --experimental-vm-modules to start, so it could never be a plain
// tools/check-*.mjs, so the release sweep never picked it up. It then broke —
// cache-bust.mjs began stamping `?v=` onto the import specifiers it matched
// exactly — and threw before its FIRST assertion for an unknown number of
// releases. 134 checks on the wording of somebody's hackathon record, none of
// them running, and the suite reporting all-green throughout.
//
// A check nobody runs is documentation. This is the four lines that make it a
// check again.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(
  process.execPath,
  ["--experimental-vm-modules", join(ROOT, "tools", "member-checks", "check.mjs")],
  { encoding: "utf8" }
);

const out = (r.stdout || "") + (r.stderr || "");

// ⚠ A ZERO EXIT IS NOT ENOUGH. The failure this wrapper exists to catch was a
// throw during module linking, and a harness that only forwards the exit code
// would report a suite that never ran as a suite that passed. The count is
// read back and required to be non-zero, so "nothing ran" fails loudly.
const m = /(\d+)\s+check\(s\) run\./.exec(out);
const ran = m ? Number(m[1]) : 0;

if (r.status !== 0 || !ran) {
  console.error(out.trim());
  console.error(
    ran
      ? `\n  FAIL  member-profile checks: ${ran} ran, and at least one failed.`
      : "\n  FAIL  member-profile checks did not run at all — the file threw before asserting anything."
  );
  process.exit(1);
}

console.log(`  ok    member profile: ${ran} check(s), all passing`);
