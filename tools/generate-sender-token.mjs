// Generate the shared secret the notification senders check.
//
//   node tools/generate-sender-token.mjs
//
// ============================================================
// Why this exists at all
// ============================================================
//
// `send-push` and `send-notification-emails` used to compare the caller's
// bearer token against their own `SUPABASE_SERVICE_ROLE_KEY`. That is a
// reasonable design and it failed for a reason nobody could fix: the value
// Supabase injects into the functions matches NONE of the keys the dashboard
// offers. Measured on 7 Aug 2026 by comparing SHA-256 digests — no key was
// ever printed, pasted into a chat, or read by anyone:
//
//   legacy anon           f4e4007580e1a840…
//   legacy service_role   ebd2c24b273f50d4…
//   new sb_secret_…       885d35370aa63566…
//   the functions' env    3182d70e63d9e445…   ← matches none of them
//
// Storing the legacy service_role key in the Vault and invoking by hand still
// returned 403 {"error":"Not allowed"}, which settled it empirically rather
// than by argument. Most likely the JWT secret was rotated at some point after
// the value was injected, and redeploying does not refresh it.
//
// So the senders stop depending on a value we cannot obtain and use one we
// create. The token is ours, it is single-purpose, and it can be rotated by
// running this again.
//
// ============================================================
// The value is never printed
// ============================================================
//
// Same rule as tools/generate-vapid-keys.mjs, and for the same reason: this
// project already has an outstanding key-hygiene item because two keys were
// pasted into a chat transcript on 2 Aug. A transcript is a durable, searchable
// copy of whatever passes through it.
//
// It writes C:\sctools\sender.env — outside the repo, in the short-path working
// area, which is not a git repository, so it cannot be committed by accident.
//
// Then, in order:
//
//   1. Give it to the functions (never `secrets set KEY=value`, which would put
//      it in PowerShell history):
//
//        cd C:\sctools\scpush
//        C:\sctools\node\node-v24.18.1-win-x64\npx.cmd supabase secrets set \
//          --env-file C:\sctools\sender.env --project-ref sobxhcsgtimtiqtvqbag
//
//   2. Give the SAME value to the database. Open C:\sctools\sender.env, copy
//      the part after `SENDER_TOKEN=`, and in the SQL editor:
//
//        select vault.update_secret(
//          (select id from vault.secrets where name = 'service_role_key'),
//          'PASTE_IT_HERE'
//        );
//
//   3. Delete the file and clear the SQL editor:
//
//        Remove-Item C:\sctools\sender.env
//
// ⚠ Both halves are required. Setting one without the other leaves the senders
// returning 403 exactly as before — which is the safe direction, but it is
// still not working.

import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const OUT = "C:\\sctools\\sender.env";

if (existsSync(OUT)) {
  console.error(`\n${OUT} already exists.`);
  console.error("Delete it first if you really mean to rotate the token —");
  console.error("overwriting it would strand whichever half was already set.\n");
  process.exit(1);
}

// 32 bytes, hex. Long enough that guessing is not a strategy, and hex so it
// survives copy-paste through a form, a SQL string literal and an env file
// without any quoting or encoding question.
const token = randomBytes(32).toString("hex");

// No trailing spaces, single trailing newline: the CLI splits this on `=` and
// a stray space would become part of the value, producing a mismatch that
// looks exactly like the bug this replaces.
writeFileSync(OUT, `SENDER_TOKEN=${token}\n`, "utf8");

console.log("\nSender token generated. It has NOT been printed.");
console.log(`\nIt is in:  ${OUT}`);
console.log("\nNext, both halves:");
console.log("\n  1. cd C:\\sctools\\scpush");
console.log("     C:\\sctools\\node\\node-v24.18.1-win-x64\\npx.cmd supabase secrets set \\");
console.log("       --env-file C:\\sctools\\sender.env --project-ref sobxhcsgtimtiqtvqbag");
console.log("\n  2. Open the file, copy the value after SENDER_TOKEN=, and run:");
console.log("       select vault.update_secret(");
console.log("         (select id from vault.secrets where name = 'service_role_key'),");
console.log("         'PASTE_IT_HERE'");
console.log("       );");
console.log("\n  3. Remove-Item C:\\sctools\\sender.env   (and clear the SQL editor)\n");
