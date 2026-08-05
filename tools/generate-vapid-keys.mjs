// Generate a VAPID keypair for web push.
//
// ⚠ RUN THIS YOURSELF. Do not ask an agent to run it and read you the output.
//
// This project already carries an outstanding key-hygiene item — a service_role
// JWT and an sb_secret_ key were pasted into a chat transcript on 2 Aug and
// both still need revoking. A transcript is a durable, searchable copy of
// whatever passes through it. So this script is built so that **the private
// key is never printed**: it goes straight to a file, outside the repo, and
// only the PUBLIC key reaches your screen.
//
// What the two keys are:
//   PUBLIC  — safe in source. It ships to every browser in lib/push.js; that
//             is how the browser knows which server may push to it.
//   PRIVATE — signs the VAPID JWT. Anyone holding it can send notifications
//             that appear to come from Sahaba Club. It belongs in Supabase
//             secrets and nowhere else. Not in the repo, not in a chat, not in
//             your shell history.
//
// Usage:
//
//   node tools/generate-vapid-keys.mjs
//
// It writes C:\sctools\vapid.env (outside the repo — chosen because
// C:\sctools\ is already the short-path working area and is not a git
// repository, so there is no way to commit it by accident). Then:
//
//   cd C:\sctools\scpush
//   C:\sctools\node\node-v24.18.1-win-x64\npx.cmd supabase secrets set \
//     --env-file C:\sctools\vapid.env --project-ref sobxhcsgtimtiqtvqbag
//
// …and then DELETE the file:
//
//   Remove-Item C:\sctools\vapid.env
//
// Using --env-file rather than `secrets set KEY=value` is deliberate: the
// second form puts the private key into your PowerShell history, where it
// stays.
//
// ⚠ Rotating the keypair invalidates every existing subscription. Browsers
// bind a subscription to the public key that created it, so after a rotation
// every member has to re-enable push. Generate once.

import { writeFileSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";

const OUT = "C:\\sctools\\vapid.env";

// VAPID is ECDSA on P-256 (ES256). Both values are base64url, unpadded.
function b64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

if (existsSync(OUT)) {
  console.error(`Refusing to overwrite ${OUT}.`);
  console.error("If you meant to make a NEW keypair, delete that file first —");
  console.error("but note that rotating invalidates every existing subscription.");
  process.exit(1);
}

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

// Public: the uncompressed EC point, 65 bytes starting 0x04. This exact
// encoding is what applicationServerKey expects in the browser.
const rawPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) {
  console.error(`Unexpected public key encoding (${rawPublic.length} bytes) — refusing to write.`);
  process.exit(1);
}

// Private: the raw 32-byte scalar. JWK's `d` is already base64url of exactly
// that, which is the format web-push libraries want.
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
if (!jwk.d) {
  console.error("Private key export produced no `d` component — refusing to write.");
  process.exit(1);
}

const publicKey = b64url(rawPublic);
const privateKey = jwk.d;

// Sanity: the browser rejects a malformed applicationServerKey with a vague
// error, so check the shape here where the message can be useful.
if (publicKey.length !== 87) {
  console.error(`Public key is ${publicKey.length} chars, expected 87 — refusing to write.`);
  process.exit(1);
}
if (privateKey.length !== 43) {
  console.error(`Private key is ${privateKey.length} chars, expected 43 — refusing to write.`);
  process.exit(1);
}

writeFileSync(OUT, `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`, "utf8");

console.log("");
console.log("VAPID keypair generated.");
console.log("");
console.log("PUBLIC KEY — safe to publish, paste this into lib/push.js:");
console.log("");
console.log("  " + publicKey);
console.log("");
console.log("The PRIVATE key has NOT been printed. Both values are in:");
console.log("  " + OUT);
console.log("");
console.log("Next:");
console.log("  cd C:\\sctools\\scpush");
console.log("  C:\\sctools\\node\\node-v24.18.1-win-x64\\npx.cmd supabase secrets set \\");
console.log("    --env-file C:\\sctools\\vapid.env --project-ref sobxhcsgtimtiqtvqbag");
console.log("");
console.log("Then delete the file:");
console.log("  Remove-Item C:\\sctools\\vapid.env");
console.log("");
