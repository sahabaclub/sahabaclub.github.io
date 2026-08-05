// send-transactional-email
// ------------------------------------------------------------
// One function, one job: hand a template + data to Resend. Called from
// other Edge Functions (provision-ms365, notify-ms365-reset and
// register-interest today; booking confirmations and event reminders
// land here too once those phases start) rather than from the browser,
// so the Resend API key never reaches the client.
//
// Secrets this function needs (see SETUP.md):
//   RESEND_API_KEY
//   RESEND_FROM   — e.g. "Sahaba Club <members@sahabaclub.com>"
//   INTEREST_NOTIFY_EMAIL — optional; where hackathon interest lands.
//                           Defaults to the club address below. Set it to
//                           the same value in register-interest, or leave
//                           both unset.
import { corsHeaders } from "../_shared/cors.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <members@sahabaclub.com>";

type TemplateName =
  | "welcome"
  | "ms365_credential"
  | "ms365_linked"
  | "ms365_reset_request"
  | "hackathon_interest";

// Every link in a member-facing email points at the live site. Relative URLs
// are meaningless in an inbox, and a hard-coded host that drifts is how a
// welcome email ends up sending people to a 404.
const SITE = (Deno.env.get("SITE_URL") ?? "https://www.sahabaclub.ai").replace(/\/+$/, "");

// ⚠ TEMPLATES WHOSE RECIPIENT IS DECIDED HERE, NOT BY THE CALLER.
//
// `hackathon_interest` is rendered from data typed into a PUBLIC, ANONYMOUS
// form (register-interest). That function already hardcodes the destination
// and never reads it from the request — but "the caller is careful" is a
// property of one file that can be edited, and the thing being protected is
// this domain's ability to send mail at all. Pinning it a second time here
// means that even a register-interest that started passing a caller-supplied
// `to` could not turn this into a mailer for strangers: the address below is
// the only place this template can ever be delivered.
//
// Templates not in this map keep the old behaviour — `to` comes from the
// caller, who has had to prove they hold the service-role key.
const INTEREST_NOTIFY_EMAIL = Deno.env.get("INTEREST_NOTIFY_EMAIL") ?? "ahmed@sahabaclub.com";
const FIXED_RECIPIENT: Partial<Record<TemplateName, string>> = {
  hackathon_interest: INTEREST_NOTIFY_EMAIL,
};

// ---- Keeping Ahmed on the member-facing mail --------------------------
//
// Ahmed's ask, 5 Aug: copy him on every onboarding email. Deliberately a
// per-template allowlist rather than a blanket cc, because two of the four
// templates are ALREADY addressed to him — `hackathon_interest` and
// `ms365_reset_request` both land in a club inbox — and cc-ing those would
// simply deliver him everything twice.
//
// ⚠ `ms365_credential` carries a temporary password, so this puts that password
// in a second inbox. It is a one-use credential that Microsoft forces the
// member to change at first sign-in, and Ahmed is the tenant admin who can
// reset it anyway, so the marginal exposure is small — but it is real, and
// swapping `cc` for `bcc` below is the one-word change if it should not be
// visible to the member either.
const CC_ADDRESS = Deno.env.get("ONBOARDING_CC_EMAIL") ?? "ahmed@sahabaclub.com";
const CC_ON_MEMBER_MAIL: TemplateName[] = ["welcome", "ms365_credential", "ms365_linked"];

// ⚠ NOTHING FROM A CALLER GOES INTO HTML WITHOUT PASSING THROUGH HERE.
//
// The ms365_reset_request template interpolates a member's own name and the
// free-text "how did you hear about us" they typed on a form years ago —
// values this codebase did not generate. Escaping them keeps a stray angle
// bracket from breaking the mail, and keeps anything worse out of Ahmed's
// inbox. The two oldest templates render system-generated values only.
//
// `hackathon_interest` raises the stakes: all four of its values are typed by
// an ANONYMOUS stranger into a public form and land, unread by anyone, in a
// club mailbox. A name of `<img src=x onerror=…>` or `<a href="…">Click to
// verify</a>` is a script tag and a phishing link in Ahmed's mail client,
// authenticated by our own DKIM signature. Every single interpolation in that
// template is esc() or orUnknown() — not most of them.
function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function orUnknown(v: unknown) {
  const s = String(v ?? "").trim();
  return s ? esc(s) : "<em>not on record</em>";
}

function renderTemplate(template: TemplateName, data: Record<string, unknown>) {
  if (template === "hackathon_interest") {
    // Somebody has asked to be told about a hackathon round from the public
    // page. This is a lead, so it reads as one: who they are, how to reach
    // them, and what they do — nothing else, because nothing else was asked
    // for and nothing else is known.
    //
    // Every value below is a stranger's. esc() on all of them, and no `href`,
    // `src` or `style` anywhere takes one: a mailto: built from a submitted
    // address is a link this function would be vouching for, so the address is
    // shown as text and the reader decides.
    const round = esc(data.roundName || data.roundSlug);
    const repeat = Boolean(data.repeat);
    return {
      subject: `${round}: ${esc(data.fullName) || "Someone"} wants to take part`,
      html: `
        <p><strong>${orUnknown(data.fullName)}</strong> has registered interest in
           <strong>${round}</strong> from the hackathons page.</p>
        <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr><td><strong>Name</strong></td><td>${orUnknown(data.fullName)}</td></tr>
          <tr><td><strong>Email</strong></td><td>${orUnknown(data.email)}</td></tr>
          <tr><td><strong>Mobile</strong></td><td>${orUnknown(data.mobile)}</td></tr>
          <tr><td><strong>Currently</strong></td><td>${orUnknown(data.currentJob)}</td></tr>
          <tr><td><strong>Round</strong></td><td>${round} (${esc(data.roundSlug)})</td></tr>
        </table>
        <p style="color:#555;font-size:13px">Typed into a public form by someone who is not signed in,
           so treat the details as unverified until you have spoken to them. They are already recorded
           and visible under <em>Interest</em> in the admin dashboard.</p>
        ${repeat
          ? '<p style="color:#555;font-size:13px">This is a repeat notification: they were registered ' +
            "earlier but the first email did not go out.</p>"
          : ""}
        <p style="color:#555;font-size:13px">Registration id: ${esc(data.registrationId)}</p>
      `,
    };
  }

  if (template === "ms365_reset_request") {
    // Sent to staff, not to the member — it is a work item, so it reads as
    // one: who, how to reach them, and why we believe the mailbox is theirs.
    const mailbox = esc(data.mailbox);
    return {
      subject: `Microsoft 365 password reset requested — ${mailbox}`,
      html: `
        <p><strong>${orUnknown(data.fullName)}</strong> has signed up on sahabaclub.ai and
           recognised their Sahaba Club Microsoft 365 mailbox, but does not know the
           password. They are asking you to reset it.</p>
        <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr><td><strong>Mailbox</strong></td><td>${mailbox}</td></tr>
          <tr><td><strong>Name</strong></td><td>${orUnknown(data.fullName)}</td></tr>
          <tr><td><strong>Personal email</strong></td><td>${orUnknown(data.personalEmail)}</td></tr>
          <tr><td><strong>Mobile</strong></td><td>${orUnknown(data.phone)}</td></tr>
          <tr><td><strong>With the club since</strong></td><td>${orUnknown(data.memberSince)}</td></tr>
          <tr><td><strong>Where they came from</strong></td><td>${orUnknown(data.contactSource)}</td></tr>
        </table>
        <p style="color:#555;font-size:13px">Matched because that personal email is already
           on record against this mailbox. They were not asked to type it, and they were
           never shown any mailbox other than their own.</p>
        <p style="color:#555;font-size:13px">Request id: ${esc(data.requestId)}</p>
      `,
    };
  }

  if (template === "ms365_credential") {
    const mailbox = String(data.mailbox ?? "");
    const tempPassword = String(data.tempPassword ?? "");
    const preExisting = Boolean(data.preExisting);
    return {
      subject: preExisting
        ? "Your Sahaba Club Microsoft 365 account is reset"
        : "Your Sahaba Club Microsoft 365 account is ready",
      html: `
        <p>Hi,</p>
        <p>${preExisting ? "Your existing" : "Your new"} Microsoft 365 mailbox is ready.</p>

        <table cellpadding="6" style="border-collapse:collapse;margin:12px 0">
          <tr><td><strong>Email</strong></td><td><code>${mailbox}</code></td></tr>
          <tr><td><strong>Temporary password</strong></td><td><code>${tempPassword}</code></td></tr>
        </table>

        <p><strong>Signing in the first time</strong></p>
        <ol>
          <li>Go to <a href="https://www.microsoft365.com">microsoft365.com</a> and choose
              <strong>Sign in</strong>.</li>
          <li>Use the address above — <em>not</em> your personal email.</li>
          <li>Enter the temporary password, then choose one of your own. Microsoft will insist,
              and after that only you know it.</li>
          <li>You may be asked for a phone number or the Authenticator app. That is for
              recovering your own account; the club cannot see it.</li>
        </ol>

        <p><strong>What comes with it</strong></p>
        <ul>
          <li>Email at your @sahabaclub.com address, in Outlook on the web or the app.</li>
          <li>Word, Excel, PowerPoint and OneNote in the browser.</li>
          <li>1&nbsp;TB of OneDrive storage.</li>
          <li>Microsoft Teams, for club events and talking to other members.</li>
          <li>Forms, Planner, Lists and Sway — what the hackathons run on.</li>
        </ul>
        <p style="color:#555;font-size:13px">The desktop Office apps are not on this licence.
           The browser versions do the same work.</p>

        <p>Free for your first 3 months as a member. These details are also on
           <a href="${SITE}/app/dashboard.html">your dashboard</a> under Microsoft 365 if you
           lose this email.</p>
        <p>— Sahaba Club</p>
      `,
    };
  }
  // "ms365_linked" — a member who ALREADY had an @sahabaclub.com mailbox and
  // has just connected it to their club account.
  //
  // This path sent nothing at all until now, which was the worse half of the
  // gap: returning EduHackAI participants linked an account and heard silence.
  // It deliberately carries NO password — they already have one, the club never
  // knew it, and offering to "remind" them of it would be a lie. Everything
  // else is the same welcome the created-mailbox members get.
  if (template === "ms365_linked") {
    const mailbox = String(data.mailbox ?? "");
    return {
      subject: "Your Microsoft 365 account is connected",
      html: `
        <p>Hi,</p>
        <p>Your Microsoft 365 mailbox is now connected to your Sahaba Club account:</p>
        <p><strong>${esc(mailbox)}</strong></p>
        <p>Sign in at <a href="https://www.microsoft365.com">microsoft365.com</a> with the
           password you already use for it. We don't have that password and can't see it — if
           you've forgotten it, ask for a reset from
           <a href="${SITE}/app/dashboard.html">your dashboard</a> and we'll sort it out.</p>

        <p><strong>What comes with it</strong></p>
        <ul>
          <li>Email at your @sahabaclub.com address, in Outlook on the web or the app.</li>
          <li>Word, Excel, PowerPoint and OneNote in the browser.</li>
          <li>1&nbsp;TB of OneDrive storage.</li>
          <li>Microsoft Teams, for club events and talking to other members.</li>
          <li>Forms, Planner, Lists and Sway — what the hackathons run on.</li>
        </ul>

        <p>While you're here: <a href="${SITE}/app/connect.html">Connect</a> lists members who
           have a profile picture, and <a href="${SITE}/hackathons.html">EduHackAI round 5</a>
           is open.</p>
        <p>— Sahaba Club</p>
      `,
    };
  }

  // "welcome" — sent once, the first time a member reaches onboarding.
  //
  // This template existed from the beginning and NOTHING EVER SENT IT, so the
  // first thing a new member heard from the club was a Microsoft password. It
  // is now the front door: what they get, and where to go next. Every link is
  // absolute and points at a page that is actually live — PromptArena is
  // deliberately absent because it is hidden until its challenge bank is
  // seeded, and a welcome email that opens with a dead link is worse than one
  // that says less.
  //
  // `data.fullName` is a member's own name off their profile. esc()'d like
  // everything else: it is not a string this codebase generated.
  const who = String(data.fullName ?? "").trim();
  return {
    subject: "Welcome to Sahaba Club",
    html: `
      <p>${who ? `Hi ${esc(who.split(/\s+/)[0])},` : "Hi,"}</p>
      <p>Welcome to Sahaba Club — you're in. Here is what that gets you, and where to start.</p>

      <p><strong>What's included</strong></p>
      <ul>
        <li><strong>Microsoft 365, free for 3 months</strong> — your own @sahabaclub.com mailbox,
            Office in the browser, 1&nbsp;TB of OneDrive and Teams.</li>
        <li><strong>Events and workshops</strong>, online and in person across the Gulf and
            North Africa.</li>
        <li><strong>EduHackAI hackathons</strong> — four rounds run so far, and round 5 is open
            for registration.</li>
        <li><strong>The member directory</strong>, so you can find people building the same
            things you are.</li>
        <li><strong>The podcast</strong>, and a newsletter tailored to the interests on your
            profile.</li>
      </ul>

      <p><strong>Where to go next</strong></p>
      <ul>
        <li><a href="${SITE}/app/dashboard.html">Your dashboard</a> — everything in one place</li>
        <li><a href="${SITE}/app/connect.html">Connect</a> — meet the other members</li>
        <li><a href="${SITE}/events.html">Events</a> — what's coming up</li>
        <li><a href="${SITE}/hackathons.html">EduHackAI</a> — the hackathons, and round 5</li>
        <li><a href="${SITE}/podcast.html">Podcast</a> — conversations with people in the field</li>
        <li><a href="${SITE}/membership.html">Membership</a> — what free and premium include</li>
      </ul>

      <p><strong>Two things worth doing today.</strong> Finish your profile — it is what we match
         coaches, events and introductions against, so a thin one gets thin results. And add a
         picture: <em>Connect only lists members who have one</em>, which is the single most
         common reason people cannot find themselves in the directory.</p>

      <p>Any questions, just reply to this email.</p>
      <p>— Sahaba Club</p>
    `,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Server-to-server only. This function takes an arbitrary `to` address and
    // sends from a domain we have spent DNS records establishing as genuinely
    // ours — so without this check, any signed-in member could use it to mail
    // anyone as Sahaba Club. That is an open relay, and the cost of it being
    // found is sahabaclub.com landing on a blocklist and *all* our mail, human
    // included, stopping.
    //
    // The only caller is provision-ms365, which invokes it with the service
    // role key. Nothing legitimate reaches this from a browser.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!SERVICE_ROLE_KEY || bearer !== SERVICE_ROLE_KEY) {
      console.error("send-transactional-email called without the service role key");
      return json({ error: "Not allowed" }, 403);
    }

    const { to, template, data } = await req.json();
    if (!to || !template) {
      return json({ error: "to and template are required" }, 400);
    }

    const { subject, html } = renderTemplate(template as TemplateName, data ?? {});

    // See FIXED_RECIPIENT above. For templates listed there the caller's `to`
    // is ignored outright rather than merely checked, so there is no version
    // of this call that delivers a public form's contents anywhere else.
    const recipient = FIXED_RECIPIENT[template as TemplateName] ?? to;

    // Copy Ahmed on member-facing mail only — see CC_ON_MEMBER_MAIL. Skipped
    // when he is already the recipient, which would otherwise deliver the
    // staff notifications to him twice.
    const wantsCc = CC_ON_MEMBER_MAIL.indexOf(template as TemplateName) !== -1;
    const ccList = wantsCc && CC_ADDRESS &&
        String(recipient).toLowerCase() !== CC_ADDRESS.toLowerCase()
      ? [CC_ADDRESS]
      : null;

    const payload: Record<string, unknown> = {
      from: RESEND_FROM,
      to: recipient,
      subject,
      html,
    };
    if (ccList) payload.cc = ccList;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`Resend error ${resp.status}: ${await resp.text()}`);
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
