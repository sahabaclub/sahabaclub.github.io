#!/usr/bin/env node
// preview.mjs — render the exact email a PromptArena recipient would receive
// ============================================================================
// Runs locally, on a staff machine. Never deployed, never scheduled, never
// called from the site.
//
//   node tools/promptarena-campaign/preview.mjs --campaign "PromptArena return — they have a score"
//   node tools/promptarena-campaign/preview.mjs --campaign "..." --limit 5 --open
//   node tools/promptarena-campaign/preview.mjs --stdin        # paste a draft
//
// ⚠ IT SENDS NOTHING AND CANNOT. There is no Resend key read anywhere in this
// file, no call to `send-campaign`, no call to `send-newsletter`, and no path
// that writes to the database. It does exactly two things: read staged drafts,
// and render them.
//
// ============================================================================
// Why this exists when stage-campaign.sql already previews
// ============================================================================
//
// The SQL preview shows the plain-text body, which is most of the email. It
// cannot show the other half: `send-campaign` posts BOTH a `text` and an `html`
// part to Resend, derives the HTML from the same plain text, appends the
// unsubscribe footer to each, and sets the `List-Unsubscribe` and
// `List-Unsubscribe-Post` headers. What lands in an inbox is the HTML part, so
// previewing only the text is previewing the version most people will not see.
//
// So this reproduces send-campaign's renderer exactly — and because a copy of
// somebody else's rendering logic is a copy that silently rots, it refuses to
// run when the original changes. See RENDERER_SHA below.
//
// ============================================================================
// The service-role key
// ============================================================================
//
// Read from `SUPABASE_SERVICE_ROLE_KEY` in the environment, the same way
// tools/import-prospects.mjs reads it. Never hardcoded, never printed, never
// written to a file. The three legacy tables and `campaign_recipients` are
// unreachable by any client role, so there is no lesser key that would work.
//
// ============================================================================
// The output contains real people's names and addresses
// ============================================================================
//
// It is written OUTSIDE the working copy, to the system temp directory, and
// this script refuses to write anywhere inside the repository — which is
// public. Delete the files when you have looked at them.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SEND_CAMPAIGN = join(REPO, "supabase", "functions", "send-campaign", "index.ts");

// SHA-256 of send-campaign's `sendOne` + `toHtml` region, LF-normalised.
// ⚠ If this file starts failing with "the renderer has changed", that is the
// guard working. Re-read send-campaign/index.ts, port the change into
// renderExactly() below, then update this hash. Do NOT just paste the new hash
// in: the whole point is that a preview which disagrees with the sender is
// worse than no preview, because it will be believed.
const RENDERER_SHA =
  "06f67d47518c1706b6d0f741a94442d97243aa80124851911169928bd5ea1b8c";

// Mirrors of the two constants send-campaign uses to build the footer link.
const SITE = "https://www.sahabaclub.ai";

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const has = (name) => args.includes(name);

if (has("--help") || args.length === 0) {
  console.log(
    [
      "preview.mjs — render the exact email a PromptArena recipient would receive.",
      "",
      "  --campaign <name>   read staged drafts from that campaign (needs the service-role key)",
      "  --limit <n>         how many to render, default 5",
      "  --segment <s>       filter on context_used.segment: scored | registered_only",
      "  --stdin             read one draft as: first line = subject, rest = body",
      "  --out <dir>         where to write, default a fresh folder in the system temp dir",
      "",
      "It sends nothing. It writes nothing to the database.",
    ].join("\n"),
  );
  process.exit(0);
}

// ⚠ A tripwire, not decoration. If somebody ever reaches for this script to do
// the one thing it must never do, they get told no rather than an odd error.
for (const a of args) {
  if (/^--(send|test-send|deliver|mail)$/.test(a)) {
    console.error(
      "This tool previews. It does not send, and adding a flag will not change that.\n" +
        "Sending is Ahmed approving drafts in app/admin/campaigns.html and typing SEND.",
    );
    process.exit(2);
  }
}

// ------------------------------------------------------- the drift guard

function assertRendererUnchanged() {
  let src;
  try {
    src = readFileSync(SEND_CAMPAIGN, "utf8").replace(/\r\n/g, "\n");
  } catch {
    fail(
      `Cannot read ${SEND_CAMPAIGN}.\n` +
        "This script only means anything next to the function it imitates.",
    );
  }
  const a = src.indexOf("async function sendOne(");
  const b = src.indexOf("function json(");
  if (a === -1 || b === -1 || b <= a) {
    fail("send-campaign no longer has the shape this preview was written against.");
  }
  const region = src.slice(a, b).trimEnd();
  const sha = createHash("sha256").update(region).digest("hex");
  if (sha !== RENDERER_SHA) {
    fail(
      "send-campaign's renderer has changed since this preview was written.\n" +
        `  expected ${RENDERER_SHA}\n  found    ${sha}\n\n` +
        "Read supabase/functions/send-campaign/index.ts, port the change into\n" +
        "renderExactly() in this file, and only then update RENDERER_SHA.\n" +
        "A preview that quietly disagrees with the sender is worse than none.",
    );
  }
}

// ------------------------------- send-campaign's renderer, reproduced exactly
//
// Ported from supabase/functions/send-campaign/index.ts (sendOne + toHtml).
// Kept in the same order and with the same strings so a diff is readable.

function toHtml(text) {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderExactly({ subject, body, unsubscribeToken }) {
  const unsubUrl = unsubscribeToken
    ? `${SITE}/unsubscribe.html?t=${unsubscribeToken}`
    : null;

  const text = unsubUrl
    ? `${body}\n\n—\nYou're receiving this because you registered for a Sahaba Club event.\nUnsubscribe: ${unsubUrl}`
    : body;

  const inner = unsubUrl
    ? `${toHtml(body)}<hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0 14px;">` +
      `<p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">` +
      `You're receiving this because you registered for a Sahaba Club event.<br>` +
      `<a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a></p>`
    : toHtml(body);

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
    `font-size:15px;line-height:1.65;color:#111827;max-width:560px;">${inner}</div>`;

  const headers = unsubUrl
    ? {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : {};

  return { subject, text, html, headers, hasUnsubscribe: Boolean(unsubUrl) };
}

// ------------------------------------------------------------------ reading

async function fetchDrafts({ campaignName, limit, segment }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.\n" +
        "campaign_recipients and the legacy tables are unreachable by any client role,\n" +
        "so there is no lesser key that would work. Do not paste the key into a command\n" +
        "line — export it, and never into a chat.",
    );
  }
  const rest = async (path) => {
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) fail(`Supabase said ${r.status}: ${await r.text()}`);
    return r.json();
  };

  const campaigns = await rest(
    `campaigns?select=id,name,status,from_name,from_email,reply_to,approved_count,sent_count` +
      `&name=eq.${encodeURIComponent(campaignName)}`,
  );
  if (!campaigns.length) fail(`No campaign named ${JSON.stringify(campaignName)}.`);
  const campaign = campaigns[0];

  // A statement of fact printed every run, so the state is never a surprise.
  console.log(
    `campaign: ${campaign.name}\n` +
      `  status ${campaign.status} · approved ${campaign.approved_count} · sent ${campaign.sent_count}\n` +
      `  from   ${campaign.from_name} <${campaign.from_email}>` +
      (campaign.reply_to ? ` · reply-to ${campaign.reply_to}` : ""),
  );
  if (campaign.approved_count > 0) {
    console.log(
      `  ⚠ ${campaign.approved_count} drafts are already APPROVED, which means they are ` +
        `queued for the next send.`,
    );
  }

  let q =
    `campaign_recipients?select=id,email,full_name,subject,body_text,status,context_used,` +
    `marketing_contacts(unsubscribe_token,unsubscribed_at,bounced_at,is_test,email_valid)` +
    `&campaign_id=eq.${campaign.id}&limit=${limit}`;
  if (segment) q += `&context_used->>segment=eq.${encodeURIComponent(segment)}`;

  const rows = await rest(q);
  if (!rows.length) fail("That campaign has no drafts matching those filters yet.");
  return { campaign, rows };
}

// ------------------------------------------------------------------ writing

function outputDir() {
  const wanted = flag("--out");
  const dir = wanted
    ? resolve(String(wanted))
    : join(tmpdir(), `promptarena-preview-${Date.now()}`);
  // ⚠ The repository is public and this output holds real names and addresses.
  if ((dir + sep).startsWith(REPO + sep)) {
    fail(
      `Refusing to write inside the repository (${REPO}).\n` +
        "These previews contain real people's names and email addresses, and this repo is public.",
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// --------------------------------------------------------------------- main

assertRendererUnchanged();

const dir = outputDir();
const limit = Number(flag("--limit", 5)) || 5;
const segment = flag("--segment");
let previews = [];

if (has("--stdin")) {
  const raw = readFileSync(0, "utf8").replace(/\r\n/g, "\n").trim();
  const nl = raw.indexOf("\n");
  if (nl === -1) fail("Expected a subject line, then a blank line, then the body.");
  previews.push({
    to: "you@example.com",
    name: "(pasted draft)",
    status: "(not staged)",
    note: null,
    ...renderExactly({
      subject: raw.slice(0, nl).trim(),
      body: raw.slice(nl).trim(),
      // A real token is a real token. This is plainly a placeholder so nobody
      // reads the preview as proof that a particular person's link works.
      unsubscribeToken: "00000000-0000-0000-0000-000000000000",
    }),
  });
} else {
  const campaignName = flag("--campaign");
  if (!campaignName) fail("Give --campaign <name>, or --stdin. See --help.");
  const { rows } = await fetchDrafts({ campaignName: String(campaignName), limit, segment });

  for (const r of rows) {
    const c = r.marketing_contacts ?? {};
    // Exactly what send-campaign would do with this row at this moment: if the
    // contact is no longer mailable it skips them, and the preview says so
    // rather than rendering an email that would never be sent.
    const blocked =
      (c.unsubscribed_at && "unsubscribed") ||
      (c.bounced_at && "bounced") ||
      (c.is_test && "test record") ||
      (c.email_valid === false && "email marked invalid") ||
      null;

    previews.push({
      to: r.email,
      name: r.full_name,
      status: r.status,
      note: blocked
        ? `send-campaign would SKIP this person (${blocked}), not mail them.`
        : r.context_used?.personalisation_note ?? null,
      ...renderExactly({
        subject: r.subject ?? "",
        body: r.body_text ?? "",
        unsubscribeToken: c.unsubscribe_token ?? null,
      }),
    });
  }
}

// ---- to disk, one file per recipient plus an index -------------------------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

previews.forEach((p, i) => {
  const file = join(dir, `${String(i + 1).padStart(2, "0")}.html`);
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>${esc(p.subject)}</title>` +
      `<div style="font:13px ui-monospace,monospace;background:#f6f7f9;padding:14px;margin-bottom:18px;` +
      `border:1px solid #dfe3e8;border-radius:8px;white-space:pre-wrap;">` +
      `To:      ${esc(p.to)}\nSubject: ${esc(p.subject)}\n` +
      `Draft status: ${esc(p.status)}\n` +
      `List-Unsubscribe: ${esc(p.headers["List-Unsubscribe"] ?? "MISSING — this email must not be sent")}\n` +
      `List-Unsubscribe-Post: ${esc(p.headers["List-Unsubscribe-Post"] ?? "MISSING")}` +
      (p.note ? `\n\n${esc(p.note)}` : "") +
      `</div>` +
      // The HTML part, as Resend receives it.
      p.html +
      `<hr style="margin:28px 0;border:none;border-top:1px dashed #cbd5e1;">` +
      `<p style="font:12px ui-monospace,monospace;color:#64748b;">the plain-text part, as Resend receives it</p>` +
      `<pre style="font:13px ui-monospace,monospace;white-space:pre-wrap;background:#f8fafc;` +
      `padding:14px;border-radius:8px;">${esc(p.text)}</pre>`,
    "utf8",
  );
  console.log(
    `\n${String(i + 1).padStart(2, "0")}  ${p.to}\n` +
      `    subject: ${p.subject}\n` +
      `    unsubscribe header: ${p.hasUnsubscribe ? "present" : "⚠ MISSING"}\n` +
      `    ${file}`,
  );
});

const missing = previews.filter((p) => !p.hasUnsubscribe).length;
console.log(
  `\n${previews.length} rendered into ${dir}` +
    (missing
      ? `\n⚠ ${missing} of them would go out with NO unsubscribe link and no List-Unsubscribe ` +
        `header, because the contact has no unsubscribe_token. Fix that before anything is approved.`
      : "\nAll of them carry an unsubscribe link and a List-Unsubscribe header.") +
    `\n\nNothing was sent. Nothing was written to the database.` +
    `\nThese files contain real names and addresses — delete them when you are done.`,
);
