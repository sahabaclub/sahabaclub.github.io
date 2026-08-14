// email-frame — the one shape every Sahaba Club email arrives in.
// ------------------------------------------------------------
// Before this file, there was no frame at all. `send-transactional-email`
// handed its HTML straight to Resend, so most club mail arrived as bare <p>
// tags on a white background in whatever font the client defaulted to — no
// logo, no slogan, nothing that said Sahaba Club. Two templates had grown
// their own private layouts, and they did not match each other or the site:
// `ms365_credential` was a white card, and `avatar_restart` was PURPLE
// (#5b3df5), a colour that appears nowhere in styles.css.
//
// ⚠ THE POINT OF THIS FILE IS THAT THERE IS ONLY ONE OF IT. The header, the
// palette and the footer exist here and nowhere else. If you find yourself
// writing a <table> or a hex colour inside a send-* function, that is the bug —
// add a block builder here instead. `tools/check-email-frame.mjs` fails the
// build if a sender emits its own document shell, because this drifts back
// apart within a month otherwise, and it did once already.
//
// ── Why every colour below is a literal and not a token ──
// Email has no CSS variables worth relying on and no shared stylesheet, so the
// palette has to be repeated inline on every element. These literals are the
// site's own values from styles.css, copied deliberately:
//
//   #05070d  --bg              the ground
//   #f3f4f8  --text            headings and emphasis
//   #a6acc2  --text-secondary  running text
//   #838ba4  --text-muted      footer
//   #22d3ee  --cyan            links, buttons, the logo's own colour
//   #e0a83e  --gold            marketing eyebrows only
//
// Two are DERIVED rather than copied, because the site builds its cards from a
// translucent white film (`--glass: rgba(255,255,255,.045)`) over the
// background, and email cannot composite a translucent layer. They are that
// film flattened onto #05070d:
//
//   #0b0f18  the card          ← --glass       over --bg
//   #232735  the hairline      ← --glass-border over --bg
//
// ⚠ If the site's --bg or --glass ever change, these two stop matching and have
// to be recomputed. They are not automatically in step, and nothing will tell
// you.

const SITE = (Deno.env.get("SITE_URL") ?? "https://www.sahabaclub.ai").replace(/\/+$/, "");

// ⚠ LEGALLY REQUIRED ON MARKETING MAIL, and deliberately NOT defaulted.
//
// CAN-SPAM and the UAE/EU equivalents require a real postal address on
// promotional email. A placeholder would satisfy the code and fail the law, so
// there is no fallback string here: `renderEmail` THROWS when a marketing email
// is built without one. That converts a silent compliance failure into a loud
// send failure, which is the trade you want — a campaign that refuses to go out
// is a bad afternoon, a campaign that goes out non-compliant is a bad year.
const POSTAL_ADDRESS = Deno.env.get("POSTAL_ADDRESS") ?? "";

/**
 * Whether marketing mail can legally be built at all.
 *
 * ⚠ EXISTS SO A SENDER CAN FAIL FAST, BEFORE IT DOES ANY WORK. renderEmail()
 * throws per email, which for a campaign means claiming a batch of recipients,
 * marking them 'sending', and then failing all of them one at a time — every
 * one with the same fixable cause. Worse, a campaign TEST send passes no
 * unsubscribe token, so it is not marketing, so it renders happily: the check
 * that exists to catch problems is the one thing that would not catch this.
 *
 * Asked once at the top of send-campaign, this turns that into a 503 with an
 * instruction, before a single row is claimed.
 */
export function canSendMarketing(): boolean {
  return POSTAL_ADDRESS.trim().length > 0;
}

// ⚠ NOTHING REACHES THE HTML WITHOUT PASSING THROUGH HERE.
//
// Moved out of send-transactional-email so there is exactly one escaper rather
// than one per sender. Member names, event titles typed by staff, venues
// scraped by the AI importer and "how did you hear about us" typed by anonymous
// strangers all end up in these templates. A club email is signed by our own
// DKIM key, so anything injected into one is vouched for by the domain.
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

export function orUnknown(v: unknown): string {
  const s = String(v ?? "").trim();
  return s ? esc(s) : '<em style="color:#838ba4;">not on record</em>';
}

// ⚠ A LINK IN AN EMAIL IS CHECKED, NOT TRUSTED.
//
// This rule predates the frame — it was written for `notification` — and it is
// pulled up here because it should apply to every template, not the two that
// happened to have it. An email is the most costly place for a bad link: it
// carries our DKIM signature, so a redirect out of a Sahaba Club email spends
// the club's sending reputation. Anything that is not a site-relative path is
// dropped, and the mail simply has no button.
export function safeUrl(rawHref: unknown): string {
  const raw = String(rawHref ?? "").trim();

  // \\ BACKSLASHES AND CONTROL CHARACTERS ARE REJECTED FIRST.
  //
  // `/\evil.example` passes a naive "starts with one slash" test, because
  // the second character is not a slash. Concatenated onto SITE the host still
  // ends up being ours, so this is not an open redirect — but several browsers
  // and mail proxies normalise `\` to `/` while parsing, and a rule that is only
  // safe because of what happens two steps later is not worth relying on.
  //
  // Written as plain string checks rather than a character class on purpose.
  // The regex form went through three rounds of escaping bugs: `[\\ -]` reads
  // as backslash-space-HYPHEN and would have rejected every event slug in the
  // database, and a later attempt wrote real control BYTES into this file,
  // which Deno will not parse. This version has nothing left to escape.
  if (raw.includes("\\")) return "";
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) <= 0x20) return "";
  }

  if (/^\/[^/]/.test(raw)) return SITE + raw;         // "/event.html?e=x"
  if (raw === `${SITE}` || raw.startsWith(`${SITE}/`)) return raw;
  return "";
}

const SANS = `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
// The site's own cursive chain. Caveat will not load — no client honours
// @font-face from a CDN — so this lands on Segoe Script (Windows) or Brush
// Script (Mac). Both are real handwriting faces; the fallback degrades, it does
// not collapse to Arial.
const CURSIVE = `'Caveat','Segoe Script','Bradley Hand','Brush Script MT',cursive`;

// ── Block builders ────────────────────────────────────────────────────────
// A sender composes a body out of these rather than writing HTML. Each one
// escapes its own inputs, so a caller cannot forget to.
//
// ⚠ The builders return HTML STRINGS and renderEmail does NOT escape them —
// that is the whole point. Which means: never pass a raw user value straight
// into `raw()`. It exists for the two templates that legitimately need to
// compose (the credential table), and it is the one unguarded door in the file.

export type Block = string;

/** A paragraph of running text. */
export function p(text: unknown): Block {
  return `<p style="margin:0 0 15px;font-family:${SANS};font-size:16px;line-height:1.65;color:#a6acc2;">${esc(text)}</p>`;
}

/** The opening line under the title — slightly larger, sets up what follows. */
export function lead(text: unknown): Block {
  return `<p style="margin:0 0 20px;font-family:${SANS};font-size:17px;line-height:1.6;color:#a6acc2;">${esc(text)}</p>`;
}

/**
 * A bulleted list, as a table rather than a <ul>.
 *
 * ⚠ <ul> is the single most inconsistently rendered element in email. Outlook
 * indents it differently from everything else, and several clients lose the
 * marker entirely against a dark background. A two-column table with a cyan
 * bullet glyph renders identically everywhere.
 */
export function bullets(items: Array<{ title?: unknown; text: unknown }>): Block {
  const rows = items.map((it) => {
    const strong = it.title ? `<span style="color:#f3f4f8;font-weight:650;">${esc(it.title)}</span> — ` : "";
    return `<tr>
      <td width="20" valign="top" style="padding:0 0 13px;color:#22d3ee;font-size:15px;line-height:1.6;">&#9679;</td>
      <td style="padding:0 0 13px;font-family:${SANS};font-size:15px;line-height:1.6;color:#a6acc2;">${strong}${esc(it.text)}</td>
    </tr>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 8px;">${rows}</table>`;
}

/**
 * A label/value panel — the when/where of an event, the details of a request.
 * Reads at a glance on a phone, which is the whole job of the event reminder.
 */
export function panel(rows: Array<{ label: unknown; value: unknown; raw?: boolean }>): Block {
  const body = rows.map((r) => {
    const value = r.raw ? String(r.value ?? "") : esc(r.value);
    return `<tr>
      <td width="86" valign="top" style="padding:0 10px 9px 0;font-family:${SANS};font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:#838ba4;font-weight:700;line-height:1.7;">${esc(r.label)}</td>
      <td style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:1.55;color:#f3f4f8;font-weight:650;">${value}</td>
    </tr>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#141926" style="background-color:#141926;border-collapse:collapse;border-radius:10px;margin:0 0 18px;">
    <tr><td style="padding:18px 20px 9px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${body}</table>
    </td></tr></table>`;
}

/** The one thing you want them to notice. Cyan edge, tinted ground. */
export function callout(title: unknown, text: unknown): Block {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#141926" style="background-color:#141926;border-collapse:collapse;border-radius:10px;margin:0 0 18px;">
    <tr><td style="padding:16px 18px;border-left:3px solid #22d3ee;font-family:${SANS};font-size:14.5px;line-height:1.6;color:#a6acc2;">
      <span style="color:#f3f4f8;font-weight:650;">${esc(title)}</span> ${esc(text)}
    </td></tr></table>`;
}

/** A numbered sequence — first sign-in, and nothing else so far. */
export function steps(items: Array<unknown>): Block {
  const rows = items.map((s, i) =>
    `<tr>
      <td width="26" valign="top" style="padding:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:#22d3ee;font-weight:700;">${i + 1}.</td>
      <td style="padding:0 0 12px;font-family:${SANS};font-size:15px;line-height:1.6;color:#a6acc2;">${esc(s)}</td>
    </tr>`
  ).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 10px;">${rows}</table>`;
}

/**
 * An event, in a campaign or digest. Its own tinted card so a list of six
 * scans as six things rather than one wall.
 */
export function card(opts: { eyebrow?: unknown; title: unknown; text?: unknown }): Block {
  const eyebrow = opts.eyebrow
    ? `<p style="margin:0 0 5px;font-family:${SANS};font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:#22d3ee;font-weight:700;">${esc(opts.eyebrow)}</p>`
    : "";
  const text = opts.text
    ? `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.55;color:#a6acc2;">${esc(opts.text)}</p>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#141926" style="background-color:#141926;border-collapse:collapse;border-radius:10px;margin:0 0 12px;">
    <tr><td style="padding:16px 18px;">${eyebrow}
      <p style="margin:0 0 5px;font-family:${SANS};font-size:16px;font-weight:700;color:#f3f4f8;line-height:1.35;">${esc(opts.title)}</p>${text}
    </td></tr></table>`;
}

/**
 * A credential the member has to read character by character and retype.
 *
 * ⚠ Monospace and generous letter-spacing are not decoration here. This renders
 * a temporary password; "l" against "1" and "O" against "0" is the difference
 * between signing in and mailing support. The value is escaped like everything
 * else — a generated password can contain & and <.
 */
export function credentials(rows: Array<{ label: unknown; value: unknown }>): Block {
  const body = rows.map((r) =>
    `<tr>
      <td width="86" valign="top" style="padding:0 10px 12px 0;font-family:${SANS};font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:#838ba4;font-weight:700;line-height:1.9;">${esc(r.label)}</td>
      <td style="padding:0 0 12px;font-family:ui-monospace,'Cascadia Mono',Consolas,'Courier New',monospace;font-size:15px;line-height:1.6;color:#22d3ee;letter-spacing:0.5px;word-break:break-all;">${esc(r.value)}</td>
    </tr>`
  ).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#141926" style="background-color:#141926;border-collapse:collapse;border-radius:10px;margin:0 0 18px;">
    <tr><td style="padding:18px 20px 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${body}</table>
    </td></tr></table>`;
}

/**
 * Plain text → paragraphs. For copy that arrives as text rather than as blocks:
 * campaign bodies, which are written by a model or typed by staff.
 *
 * Blank lines separate paragraphs; a single newline becomes a line break. Both
 * matter — a model writes "Dear member,\nHere is..." and losing that newline
 * runs the greeting into the sentence.
 *
 * ⚠ ESCAPED FIRST, THEN MARKED UP, and the order is the whole point. Escaping
 * after inserting <br> would escape our own tags; inserting <br> before
 * escaping would let a model's stray "<" become a tag. Campaign text is not
 * something this codebase wrote.
 */
export function paragraphs(text: unknown): Block {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p style="margin:0 0 15px;font-family:${SANS};font-size:16px;line-height:1.65;color:#a6acc2;">${esc(chunk).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * A heading inside the body, for mail long enough to need sections — the first
 * sign-in steps, what the licence includes.
 *
 * Deliberately much quieter than the h1: a second 27px heading would compete
 * with the title for what the mail is about.
 */
export function subhead(text: unknown): Block {
  return `<p style="margin:22px 0 12px;font-family:${SANS};font-size:13px;line-height:1.3;font-weight:700;letter-spacing:0.6px;color:#f3f4f8;">${esc(text)}</p>`;
}

/** A small-print aside under the main body. */
export function note(text: unknown): Block {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:13px;line-height:1.6;color:#838ba4;">${esc(text)}</p>`;
}

/**
 * Pre-built HTML, for the rare template that composes something the builders
 * above do not cover.
 *
 * ⚠ THIS IS THE ONE UNGUARDED DOOR IN THE FILE. Nothing passed here is escaped.
 * Use it for markup you wrote, never for a value that came from a member, a
 * form, a scraped page or the database. If you are reaching for it to
 * interpolate a value, you want esc() around that value or a new builder.
 */
export function raw(html: string): Block {
  return html;
}

// ── The frame ─────────────────────────────────────────────────────────────

export type Audience = "member" | "staff";

export interface EmailOptions {
  /** The grey line the inbox shows beside the subject. Never leave this empty:
   *  clients that find none scrape the body instead and show the logo's alt
   *  text, so the preview reads "Sahaba Club Sahaba Club". */
  preheader: string;
  /** What KIND of mail this is: "Welcome", "Starts in two hours". */
  eyebrow: string;
  /** Gold marks marketing, so a member can tell club news from a real
   *  notification before reading a word. Everything else is cyan. */
  eyebrowTone?: "cyan" | "gold";
  title: string;
  blocks: Block[];
  cta?: { label: string; url: string };
  /** Why this arrived. The single most effective line against spam complaints,
   *  and it differs for every template — so there is no default. */
  footerReason: string;
  /** Staff mail is a work item, not marketing: it drops the nav links and the
   *  unsubscribe, keeping the header so it is still recognisably ours. */
  audience?: Audience;
  /** Marketing only. Supplying it switches on the postal address and the
   *  unsubscribe link — and makes POSTAL_ADDRESS mandatory. */
  unsubscribeUrl?: string;
}

export function renderEmail(o: EmailOptions): string {
  const audience: Audience = o.audience ?? "member";
  const isMarketing = Boolean(o.unsubscribeUrl);

  // See POSTAL_ADDRESS above: refuse rather than ship a placeholder.
  if (isMarketing && !POSTAL_ADDRESS) {
    throw new Error(
      "POSTAL_ADDRESS is not set. Marketing email legally requires a postal " +
        "address; refusing to send rather than ship a placeholder. Set the " +
        "POSTAL_ADDRESS secret on the project and redeploy.",
    );
  }

  const accent = o.eyebrowTone === "gold" ? "#e0a83e" : "#22d3ee";
  const ctaUrl = o.cta ? safeUrl(o.cta.url) : "";
  const body = o.blocks.join("\n");

  // The CTA renders twice on purpose: a VML pill that only Outlook sees, and an
  // anchor every other client sees. Underneath, the URL again as plain text —
  // corporate mail scanners rewrite hrefs and some strip the button outright,
  // and this is what keeps the mail usable when that happens.
  const cta = o.cta && ctaUrl
    ? `
      <tr><td class="sc-pad sc-btn" align="left" style="padding:8px 40px 0;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                     href="${ctaUrl}" style="height:46px;v-text-anchor:middle;width:240px;"
                     arcsize="50%" stroke="f" fillcolor="#22d3ee">
          <w:anchorlock/>
          <center style="color:#05070d;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;">${esc(o.cta.label)}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${ctaUrl}" style="background-color:#22d3ee;color:#05070d;text-decoration:none;display:inline-block;padding:14px 30px;border-radius:999px;font-family:${SANS};font-size:15px;font-weight:700;line-height:1;mso-hide:all;">${esc(o.cta.label)}</a>
        <!--<![endif]-->
      </td></tr>
      <tr><td class="sc-pad sc-ink-3" style="padding:12px 40px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:#838ba4;">
        Or paste this into your browser:<br><span style="word-break:break-all;">${ctaUrl}</span>
      </td></tr>`
    : "";

  const navLinks = audience === "member"
    ? `<tr><td align="center" class="sc-ink-3" style="padding:12px 34px 0;font-family:${SANS};font-size:12px;line-height:2;color:#838ba4;">
        <a href="${SITE}/events.html" style="color:#a6acc2;text-decoration:none;">Events</a><span style="color:#3a3f4d;">&nbsp;·&nbsp;</span><a href="${SITE}/membership.html" style="color:#a6acc2;text-decoration:none;">Membership</a><span style="color:#3a3f4d;">&nbsp;·&nbsp;</span><a href="${SITE}/podcast.html" style="color:#a6acc2;text-decoration:none;">Podcast</a><span style="color:#3a3f4d;">&nbsp;·&nbsp;</span><a href="https://www.linkedin.com/company/sahabaclub/" style="color:#a6acc2;text-decoration:none;">LinkedIn</a><span style="color:#3a3f4d;">&nbsp;·&nbsp;</span><a href="mailto:info@sahabaclub.com" style="color:#a6acc2;text-decoration:none;">Contact</a>
      </td></tr>`
    : "";

  const legal = isMarketing
    ? `<tr><td align="center" style="padding:16px 34px 0;font-family:${SANS};font-size:11px;line-height:1.7;color:#6f7689;">
        ${esc(POSTAL_ADDRESS)}<br>
        <a href="${o.unsubscribeUrl}" style="color:#838ba4;text-decoration:underline;">Unsubscribe from club news</a>
      </td></tr>`
    : "";

  return `<!doctype html>
<html lang="en" dir="ltr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!-- ⚠ THESE TWO LINES ARE WHY THE DARK DESIGN SURVIVES. Without them Gmail and
     Outlook.com treat this as a light email and run their own inverter over it:
     the near-black ground flips to white and the light text goes with it, so the
     mail arrives white-on-white and unreadable. -->
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Sahaba Club</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  /* ⚠ NOTHING HERE IS LOAD-BEARING. Gmail strips <style> when a message is
     clipped or forwarded. This block carries only the two things inline styles
     cannot express: media queries, and the dark-mode override selectors. */
  :root { color-scheme: dark; supported-color-schemes: dark; }
  [data-ogsc] .sc-ground { background-color:#05070d !important; }
  [data-ogsc] .sc-card   { background-color:#0b0f18 !important; }
  [data-ogsc] .sc-ink    { color:#f3f4f8 !important; }
  [data-ogsc] .sc-ink-2  { color:#a6acc2 !important; }
  [data-ogsc] .sc-ink-3  { color:#838ba4 !important; }
  [data-ogsc] .sc-accent { color:${accent} !important; }
  @media only screen and (max-width:620px) {
    .sc-shell  { width:100% !important; }
    .sc-pad    { padding-left:22px !important; padding-right:22px !important; }
    .sc-h1     { font-size:23px !important; line-height:1.28 !important; }
    .sc-slogan { font-size:24px !important; }
    .sc-btn a  { display:block !important; text-align:center !important; }
  }
  @media (forced-colors:active) { .sc-btn a { border:2px solid currentColor !important; } }
  a { color:#22d3ee; }
  /* iOS turns dates and addresses into pale blue links that are close to
     unreadable on our ground. */
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; font-size:inherit !important; font-weight:inherit !important; }
</style>
</head>
<body class="sc-ground" style="margin:0;padding:0;width:100%;background-color:#05070d;">
<div style="display:none;font-size:1px;color:#05070d;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(o.preheader)}&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;</div>
<table role="presentation" class="sc-ground" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#05070d" style="background-color:#05070d;border-collapse:collapse;">
<tr><td align="center" style="padding:28px 12px 40px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="sc-shell" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;border-collapse:collapse;">

  <tr><td align="center" style="padding:8px 20px 20px;">
    <a href="${SITE}" style="text-decoration:none;">
      <!-- logo.png is the DARK-BACKGROUND logo: its wordmark is white. The alt
           text is styled cyan and bold because Outlook blocks images from
           unknown senders by default, so a large share of recipients read the
           alt text instead of seeing this. -->
      <img src="${SITE}/assets/logo.png" width="156" height="101" alt="Sahaba Club"
           style="display:block;border:0;outline:none;text-decoration:none;width:156px;height:101px;color:#22d3ee;font-family:${SANS};font-size:20px;font-weight:700;">
    </a>
  </td></tr>
  <tr><td align="center" style="padding:0 20px 9px;">
    <p class="sc-slogan sc-ink" style="margin:0;font-family:${CURSIVE};font-size:27px;line-height:1.15;font-weight:700;color:#f3f4f8;">
      The First AI Universe <span class="sc-accent" style="color:#22d3ee;">on Earth</span>
    </p>
  </td></tr>
  <tr><td align="center" style="padding:0 20px 22px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="54" style="width:54px;">
      <tr><td bgcolor="#22d3ee" height="2" style="background-color:#22d3ee;height:2px;line-height:2px;font-size:0;">&nbsp;</td></tr>
    </table>
  </td></tr>

  <!-- ⚠ Outlook on Windows renders this card with SQUARE corners — the Word
       engine has no border-radius. Accepted deliberately: the alternative is
       slicing the card into background images, which breaks the moment images
       are blocked and turns every copy edit into a design job. -->
  <tr><td class="sc-card" bgcolor="#0b0f18" style="background-color:#0b0f18;border:1px solid #232735;border-radius:16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr><td class="sc-pad" style="padding:34px 40px 0;">
        <p class="sc-accent" style="margin:0 0 10px;font-family:${SANS};font-size:11px;line-height:1.2;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${accent};">${esc(o.eyebrow)}</p>
        <h1 class="sc-h1 sc-ink" style="margin:0 0 18px;font-family:${SANS};font-size:27px;line-height:1.26;font-weight:700;color:#f3f4f8;">${esc(o.title)}</h1>
      </td></tr>
      <tr><td class="sc-pad sc-ink-2" style="padding:0 40px;font-family:${SANS};font-size:16px;line-height:1.65;color:#a6acc2;">
${body}
      </td></tr>
${cta}
      <tr><td class="sc-pad" style="padding:32px 40px 32px;">&nbsp;</td></tr>
    </table>
  </td></tr>

  <tr><td class="sc-pad" style="padding:26px 34px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr><td height="1" bgcolor="#232735" style="background-color:#232735;height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr>
    </table>
  </td></tr>
  <tr><td class="sc-pad sc-ink-3" align="center" style="padding:20px 34px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:#838ba4;">${o.footerReason}</td></tr>
${navLinks}
${legal}
  <tr><td align="center" style="padding:18px 34px 0;font-family:${CURSIVE};font-size:17px;line-height:1.3;color:#6f7689;">Developed by Sahaba Club Technologies</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
