// preview-emails.mjs
// ------------------------------------------------------------
//   node --experimental-strip-types tools/preview-emails.mjs [outfile]
//
// Renders every transactional template through the real code and writes them to
// one HTML page, each in its own iframe so the eight documents cannot fight over
// styles. Defaults to emails/preview.html.
//
// ⚠ THIS IS A PREVIEW, NOT A TEST. It proves the templates render and lets a
// human look at them; it does not prove they survive Outlook. Nothing replaces
// sending one to a real inbox — see the deployment note in HANDOFF.
//
// ⚠ The --experimental-strip-types flag is required: this imports TypeScript
// written for Deno. Deno.env and Deno.serve are shimmed below.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "emails/preview.html");

// A postal address IS set here, unlike in the checker, so the marketing sample
// renders instead of throwing. It is obviously a placeholder — the real one is
// a secret on the project, and this file is committed to a public repo.
globalThis.Deno = {
  env: {
    get: (k) =>
      k === "SITE_URL"
        ? "https://www.sahabaclub.ai"
        : k === "POSTAL_ADDRESS"
        ? "Sahaba Club · [postal address not set] · Dubai, UAE"
        : undefined,
  },
  serve: () => {},
};

const F = await import(pathToFileURL(join(root, "supabase/functions/_shared/email-frame.ts")).href);
const STE = await import(
  pathToFileURL(join(root, "supabase/functions/send-transactional-email/index.ts")).href
);

// Representative data — what a real send actually carries.
const DATA = {
  welcome: { fullName: "Ahmed Abdel Razek" },
  ms365_credential: {
    mailbox: "ahmed@sahabaclub.com",
    tempPassword: "Sahaba!7x2Qm",
    preExisting: false,
  },
  ms365_linked: { mailbox: "ahmed@sahabaclub.com" },
  ms365_reset_request: {
    mailbox: "sara@sahabaclub.com",
    fullName: "Sara Mahmoud",
    personalEmail: "s.mahmoud@example.com",
    phone: "+971 50 123 4567",
    memberSince: "March 2026",
    contactSource: "EduHackAI round 3",
    requestId: "req_8f2a11",
  },
  hackathon_interest: {
    fullName: "Omar Haddad",
    email: "omar@example.com",
    mobile: "+20 100 555 0123",
    currentJob: "ML engineer at a logistics startup",
    roundName: "EduHackAI Round 5",
    roundSlug: "round-5",
    registrationId: "reg_44c108",
  },
  notification: {
    fullName: "Ahmed Abdel Razek",
    title: "Your Microsoft 365 licence ends in 7 days",
    body: "Upgrade to Premium to keep your mailbox and everything in it.",
    href: "/app/dashboard.html",
  },
  event_reminder: {
    fullName: "Ahmed Abdel Razek",
    title: "GITEX Global 2026",
    body: "Today at 11:00 AM Dubai time, Dubai World Trade Centre.",
    href: "/event.html?e=gitex-global-2026",
  },
  avatar_restart: { fullName: "Ahmed Abdel Razek", redrawn: true },
};

const NAMES = Object.keys(DATA);
const rendered = NAMES.map((name) => {
  const r = STE.renderTemplate(name, DATA[name]);
  return { name, subject: r.subject, html: r.html };
});

// The campaign is built here rather than imported: send-campaign pulls the
// Supabase client from a URL, which Node will not resolve. These are the exact
// options that function passes, so the frame output is the same — but it is a
// reconstruction, and the label on the page says so.
rendered.push({
  name: "campaign (reconstructed)",
  subject: "Six events this month, and round 5 opens",
  html: F.renderEmail({
    preheader: "Everything worth knowing about, in the order it happens.",
    eyebrow: "Club news",
    eyebrowTone: "gold",
    title: "Six events this month, and round 5 opens",
    blocks: [
      F.paragraphs(
        "Hi Ahmed,\nHere is what is coming up at the club this month.\n\n" +
          "Dubai AI Festival runs on the 18th at Madinat Jumeirah, and members get the " +
          "discounted pass. Taming the Beast is on the 24th in Cairo — a working session on " +
          "getting useful output from large models.\n\n" +
          "EduHackAI round 5 is now open for registration.",
      ),
    ],
    footerReason: "You're receiving this because you registered for a Sahaba Club event.",
    unsubscribeUrl: "https://www.sahabaclub.ai/unsubscribe.html?t=sample",
  }),
});

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const cards = rendered.map(({ name, subject, html }) => `
  <section class="item">
    <header>
      <h2>${esc(name)}</h2>
      <p class="subj"><span>Subject</span> ${esc(subject)}</p>
      <p class="meta">${html.length.toLocaleString()} bytes</p>
    </header>
    <iframe title="${esc(name)}" srcdoc="${esc(html)}" loading="lazy"></iframe>
  </section>`).join("\n");

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sahaba Club — rendered emails</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:28px 20px 80px; background:#10131a; color:#e8eaf2;
         font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  h1 { font-size:24px; margin:0 0 6px; letter-spacing:-0.01em; }
  .lede { color:#98a0b4; margin:0 0 30px; font-size:14.5px; max-width:70ch; line-height:1.6; }
  .grid { display:grid; gap:26px; grid-template-columns:repeat(auto-fill,minmax(620px,1fr)); }
  @media (max-width:700px){ .grid{ grid-template-columns:1fr; } }
  .item { background:#171b24; border:1px solid #262b37; border-radius:12px; overflow:hidden; }
  header { padding:14px 16px; border-bottom:1px solid #262b37; }
  h2 { font-size:13px; margin:0 0 6px; font-family:ui-monospace,Consolas,monospace;
       color:#7fd7e8; font-weight:600; }
  .subj { margin:0; font-size:14px; color:#e8eaf2; }
  .subj span { font-size:10px; letter-spacing:.12em; text-transform:uppercase;
               color:#767e92; margin-right:7px; }
  .meta { margin:5px 0 0; font-size:11px; color:#767e92; }
  iframe { width:100%; height:760px; border:0; background:#05070d; display:block; }
</style></head>
<body>
  <h1>Sahaba Club — every email, rendered</h1>
  <p class="lede">Generated by <code>tools/preview-emails.mjs</code> from the real templates.
     Each frame is the actual HTML that would reach an inbox. Rendering here is a browser,
     not a mail client — Outlook on Windows will show square corners, and images are blocked
     by default there. Send a real test before trusting any of this.</p>
  <div class="grid">${cards}
  </div>
</body></html>`;

writeFileSync(out, page);
console.log(`  wrote ${out}`);
console.log(`  ${rendered.length} emails (${NAMES.length} real templates + 1 reconstruction)`);
for (const r of rendered) console.log(`    ${r.name.padEnd(28)} ${String(r.html.length).padStart(6)} bytes`);
