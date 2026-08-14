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
// ⚠ EVERY TEMPLATE BELOW RENDERS THROUGH renderEmail(). None of them builds a
// <table>, a <html> document or a hex colour of its own any more — those all
// live in _shared/email-frame.ts, which is the only place the club's email
// design exists. tools/check-email-frame.mjs fails if that stops being true.
import {
  bullets,
  callout,
  card,
  credentials,
  esc,
  lead,
  note,
  orUnknown,
  p,
  panel,
  raw,
  renderEmail,
  safeUrl,
  steps,
  subhead,
} from "../_shared/email-frame.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <members@sahabaclub.com>";

// ⚠ THE EVENT REMINDER SENDS FROM ITS OWN ADDRESS. Ahmed, 13 Aug.
//
// Two things about this that are easy to get wrong:
//
// 1. **Resend verifies a DOMAIN, not an address.** sahabaclub.com is already
//    verified — members@ has been sending from it — so events@ needs NOTHING
//    added in Resend. Any address at a verified domain can send. If this ever
//    starts failing with a 403 naming the from address, the domain's
//    verification lapsed; do not go looking for a per-address setting.
//
// 2. **A from address people can REPLY to must be able to receive.** Resend
//    only sends. If events@sahabaclub.com does not exist as a mailbox in the
//    Microsoft 365 tenant, every reply to a reminder bounces — and a reminder
//    is exactly the mail somebody replies to ("can't make it", "is it still
//    on?"). See SETUP.md §8 for which kind of mailbox that should be.
const EVENTS_FROM = Deno.env.get("EVENTS_FROM") ?? "Sahaba Club Events <events@sahabaclub.com>";

type TemplateName =
  | "welcome"
  | "ms365_credential"
  | "ms365_linked"
  | "ms365_reset_request"
  | "hackathon_interest"
  | "notification"
  | "event_reminder"
  | "avatar_restart";

// Per-template sender. Anything absent falls back to RESEND_FROM, so adding a
// template never silently changes who existing mail comes from.
const FROM_BY_TEMPLATE: Partial<Record<TemplateName, string>> = {
  event_reminder: EVENTS_FROM,
};

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

// What the licence actually includes. ONE list, because it was two before —
// `ms365_credential` and `ms365_linked` each carried their own copy of the same
// five bullets, and a licence change would have had to be remembered twice.
// They describe the same licence; they are the same list.
const MS365_BENEFITS = [
  { text: "Email at your @sahabaclub.com address, in Outlook on the web or the app." },
  { text: "Word, Excel, PowerPoint and OneNote in the browser." },
  { text: "1 TB of OneDrive storage." },
  { text: "Microsoft Teams, for club events and talking to other members." },
  { text: "Forms, Planner, Lists and Sway — what the hackathons run on." },
];

// ⚠ NOTHING FROM A CALLER GOES INTO HTML WITHOUT PASSING THROUGH esc().
//
// esc() and orUnknown() now live in _shared/email-frame.ts so there is one
// escaper rather than one per sender, but the reasoning is unchanged and still
// applies to every interpolation below:
//
// The ms365_reset_request template interpolates a member's own name and the
// free-text "how did you hear about us" they typed on a form years ago —
// values this codebase did not generate. Escaping them keeps a stray angle
// bracket from breaking the mail, and keeps anything worse out of Ahmed's
// inbox.
//
// `hackathon_interest` raises the stakes: all four of its values are typed by
// an ANONYMOUS stranger into a public form and land, unread by anyone, in a
// club mailbox. A name of `<img src=x onerror=…>` or `<a href="…">Click to
// verify</a>` is a script tag and a phishing link in Ahmed's mail client,
// authenticated by our own DKIM signature.
//
// ⚠ The block builders (p, bullets, panel, card, credentials…) escape their own
// inputs, so the common case is now safe by default. The exception is raw(),
// which escapes nothing — it is used twice below, both times on markup this
// file wrote, never on a caller's value.

// ⚠ EXPORTED SO IT CAN BE RENDERED OUTSIDE A REQUEST. Nothing in production
// imports this — Deno.serve below is the only caller. It is exported so
// tools/check-email-frame.mjs can render all eight templates for real and
// assert on the actual HTML, rather than pattern-matching the source and hoping.
// Three of these templates had never been rendered by anything before that
// check existed; two of them had never been sent at all.
export function renderTemplate(template: TemplateName, data: Record<string, unknown>) {
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
    // ⚠ SUBJECTS ARE PLAIN TEXT, NOT HTML — esc() must not touch them.
    //
    // This was a real bug until 14 Aug: the subject interpolated esc(fullName)
    // and esc(roundName), so a participant called "Sara & Omar" produced the
    // subject "Sara &amp; Omar wants to take part" in Ahmed's inbox. Mail
    // clients render a Subject header literally; there is no HTML parser on it.
    // The plain values go in the subject, the escaped ones go in the body.
    const roundPlain = String(data.roundName || data.roundSlug || "").trim();
    const namePlain = String(data.fullName ?? "").trim();
    const repeat = Boolean(data.repeat);
    return {
      subject: `${roundPlain}: ${namePlain || "Someone"} wants to take part`,
      html: renderEmail({
        preheader: `${namePlain || "Someone"} registered interest in ${roundPlain}.`,
        eyebrow: "New interest",
        title: `${namePlain || "Someone"} wants to take part`,
        // Staff mail: a work item, so no nav links and no unsubscribe. It keeps
        // the header so it is still visibly ours in a crowded inbox.
        audience: "staff",
        blocks: [
          p(`Registered interest in ${roundPlain} from the hackathons page.`),
          // orUnknown() returns markup (<em>not on record</em>) for blanks, so
          // these go through raw:true having already been escaped by it.
          panel([
            { label: "Name", value: orUnknown(data.fullName), raw: true },
            { label: "Email", value: orUnknown(data.email), raw: true },
            { label: "Mobile", value: orUnknown(data.mobile), raw: true },
            { label: "Currently", value: orUnknown(data.currentJob), raw: true },
            { label: "Round", value: `${esc(roundPlain)} (${esc(data.roundSlug)})`, raw: true },
          ]),
          // ⚠ No mailto: link on that address. It was typed by an anonymous
          // stranger, and a link built from it would be one this domain vouches
          // for. It is shown as text and the reader decides.
          note(
            "Typed into a public form by someone who is not signed in, so treat the details as " +
              "unverified until you have spoken to them. They are already recorded under Interest " +
              "in the admin dashboard.",
          ),
          repeat
            ? note("This is a repeat notification: they were registered earlier but the first email did not go out.")
            : raw(""),
          note(`Registration id: ${String(data.registrationId ?? "")}`),
        ],
        footerReason: "You are getting this because you handle hackathon registrations.",
      }),
    };
  }

  if (template === "ms365_reset_request") {
    // Sent to staff, not to the member — it is a work item, so it reads as
    // one: who, how to reach them, and why we believe the mailbox is theirs.
    // Plain for the subject, escaped for the body — see the note on
    // hackathon_interest above.
    const mailboxPlain = String(data.mailbox ?? "").trim();
    const namePlain = String(data.fullName ?? "").trim();
    return {
      subject: `Microsoft 365 password reset requested — ${mailboxPlain}`,
      html: renderEmail({
        preheader: `${namePlain || "A member"} cannot sign in to ${mailboxPlain}.`,
        eyebrow: "Password reset",
        title: `${namePlain || "A member"} needs their mailbox reset`,
        audience: "staff",
        blocks: [
          p(
            "They signed up on sahabaclub.ai and recognised their Sahaba Club Microsoft 365 " +
              "mailbox, but do not know the password.",
          ),
          panel([
            { label: "Mailbox", value: orUnknown(data.mailbox), raw: true },
            { label: "Name", value: orUnknown(data.fullName), raw: true },
            { label: "Personal email", value: orUnknown(data.personalEmail), raw: true },
            { label: "Mobile", value: orUnknown(data.phone), raw: true },
            { label: "Member since", value: orUnknown(data.memberSince), raw: true },
            { label: "Came from", value: orUnknown(data.contactSource), raw: true },
          ]),
          note(
            "Matched because that personal email is already on record against this mailbox. They " +
              "were not asked to type it, and they were never shown any mailbox other than their own.",
          ),
          note(`Request id: ${String(data.requestId ?? "")}`),
        ],
        footerReason: "You are getting this because you administer the Microsoft 365 tenant.",
      }),
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
      html: renderEmail({
        preheader: `Your mailbox ${mailbox} is ready, with a temporary password inside.`,
        eyebrow: preExisting ? "Account reset" : "Account ready",
        title: preExisting
          ? "Your Microsoft 365 mailbox is reset"
          : "Your Microsoft 365 mailbox is ready",
        blocks: [
          lead(
            preExisting
              ? "Your existing mailbox has been reset. Here are the details you need to get back in."
              : "Here are the details you need to sign in for the first time.",
          ),
          // Monospace, cyan, letter-spaced — see the builder. This is a value
          // somebody has to retype character by character.
          credentials([
            { label: "Email", value: mailbox },
            { label: "Password", value: tempPassword },
          ]),
          note("Temporary — Microsoft will make you choose your own the first time you sign in."),
          subhead("Signing in the first time"),
          steps([
            "Go to microsoft365.com and choose Sign in.",
            "Use the address above — not your personal email.",
            "Enter the temporary password, then choose one of your own. Microsoft will insist, and after that only you know it.",
            "You may be asked for a phone number or the Authenticator app. That is for recovering your own account; the club cannot see it.",
          ]),
          subhead("What comes with it"),
          bullets(MS365_BENEFITS),
          note("The desktop Office apps are not on this licence. The browser versions do the same work."),
          p("Free for your first 3 months as a member."),
        ],
        cta: { label: "Open your dashboard", url: "/app/dashboard.html" },
        footerReason:
          "You are getting this because a Microsoft 365 mailbox was set up for your Sahaba Club membership. " +
          "These details are also on your dashboard if you lose this email.",
      }),
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
      html: renderEmail({
        preheader: `${mailbox} is now connected to your Sahaba Club account.`,
        eyebrow: "Account connected",
        title: "Your Microsoft 365 account is connected",
        blocks: [
          lead("Your mailbox is now linked to your Sahaba Club account."),
          panel([{ label: "Mailbox", value: mailbox }]),
          // ⚠ NO PASSWORD AND NO OFFER TO REMIND THEM OF ONE. They already have
          // a password, the club never knew it, and saying otherwise would be a
          // lie. This is the difference between this template and
          // ms365_credential, and it is the whole reason there are two.
          p(
            "Sign in at microsoft365.com with the password you already use for it. We don't have " +
              "that password and can't see it — if you've forgotten it, ask for a reset from your " +
              "dashboard and we'll sort it out.",
          ),
          subhead("What comes with it"),
          bullets(MS365_BENEFITS),
          callout(
            "While you're here:",
            "Connect lists members who have a profile picture, and EduHackAI round 5 is open.",
          ),
        ],
        cta: { label: "Open your dashboard", url: "/app/dashboard.html" },
        footerReason:
          "You are getting this because you connected a Microsoft 365 mailbox to your Sahaba Club account.",
      }),
    };
  }

  // "avatar_restart" — the 8 Aug 2026 announcement.
  //
  // ⚠ ONE TEMPLATE, TWO TRUTHS. Ahmed asked that this go to every member, and
  // the headline sentence he wrote is "we generated a new avatar for you".
  // That is true only for the members whose picture the redraw could actually
  // reach — 0061 calls them group A. For everyone else (a linked Google or
  // Microsoft picture, or no picture at all) nothing was drawn, because
  // refresh-avatars will not follow a URL out of a member-writable column and
  // hands them an initials tile instead, which is not an avatar.
  //
  // Sending them all the same sentence would mean telling a member to go and
  // admire a picture that does not exist. So `redrawn` picks the middle
  // paragraph and everything else stays identical: one announcement, no
  // recipient told something untrue about their own account.
  if (template === "avatar_restart") {
    const who = String(data.fullName ?? "").trim();
    const first = who ? who.split(/\s+/)[0] : "";
    const redrawn = data.redrawn === true;

    // ⚠ THIS TEMPLATE WAS PURPLE. #5b3df5 on a #f4f3fb ground, with its own
    // white card and its own header — a colour that appears nowhere in
    // styles.css and nowhere else in the club's mail. It predated the frame and
    // was the clearest argument for building one.
    //
    // ⚠ ONE TEMPLATE, TWO TRUTHS, and that has not changed. Ahmed asked that
    // this go to every member, and the headline he wrote is "we generated a new
    // avatar for you". That is true only for members whose picture the redraw
    // could actually reach — 0061 calls them group A. For everyone else (a
    // linked Google or Microsoft picture, or none at all) nothing was drawn,
    // because refresh-avatars will not follow a URL out of a member-writable
    // column. Sending them all the same sentence would mean telling a member to
    // go and admire a picture that does not exist. `redrawn` picks the callout
    // and everything else stays identical.
    return {
      subject: redrawn
        ? "Your new avatar is ready"
        : "The avatar system just got an upgrade",
      html: renderEmail({
        preheader: redrawn
          ? "We redrew your avatar on the new system, and reset everyone back to three tries."
          : "The avatar studio was rebuilt, and everyone is back to three tries.",
        eyebrow: "Avatar studio",
        title: redrawn ? "We redrew your avatar" : "Our avatar studio got an upgrade",
        blocks: [
          lead(
            (first ? `Hi ${first}, we` : "We") +
              "'ve been rebuilding how the club makes profile pictures — new artwork, a new " +
              "prompt, and a much better eye for detail.",
          ),
          redrawn
            ? callout(
              "Your new avatar is already waiting for you.",
              "We generated a fresh one on the new system — go and see what it made of you.",
            )
            : callout(
              "Your picture is untouched.",
              "We only redrew avatars the studio could work from, and yours wasn't one of them. " +
                "But the new system is right there, and it takes about a minute to try.",
            ),
          p(
            "And because a new system deserves a fair go, we've reset everyone's avatar allowance " +
              "back to full. Three fresh tries, on the house.",
          ),
          p(
            "Don't love it? Generate another, pick an older one from your gallery, or keep a real " +
              "photograph instead — it's your face, your call.",
          ),
        ],
        cta: {
          label: redrawn ? "See your new avatar" : "Try the new avatar system",
          url: "/app/dashboard.html#profile",
        },
        footerReason:
          "You are getting this because you are a Sahaba Club member and it affects your profile picture.",
      }),
    };
  }

  // "notification" — the email copy of a notification with a deadline.
  //
  // ONE template for all of them, rather than one per kind. The three kinds
  // that email — Microsoft 365 expiry, membership renewal, and the hour before
  // an event — already carry their own title, body and link, written once in
  // 0045 and shown identically in the app. A second set of wordings here would
  // be a second thing to keep in step, and the day they disagreed the member
  // would be told two different things about the same deadline.
  //
  // ⚠ EVERY VALUE IS esc()'d. `title` and `body` are generated by the sweeps
  // in 0045, but they interpolate a member's own mailbox name and an event
  // title typed by staff — neither is a string this file produced.
  //
  // ⚠ `href` is checked, not trusted. The database constrains
  // notifications.href to a single leading slash (0044), but an email is the
  // one place a bad link is most costly: it is authenticated by our own DKIM
  // signature, so a link out of a Sahaba Club email carries the club's
  // reputation with it. Anything that is not a site-relative path is dropped
  // and the mail simply has no button.
  if (template === "notification") {
    const who = String(data.fullName ?? "").trim();
    const title = String(data.title ?? "").trim();
    const body = String(data.body ?? "").trim();
    // ⚠ `href` is checked, not trusted — safeUrl() drops anything that is not a
    // site-relative path, and the mail simply has no button. The database
    // constrains notifications.href to a single leading slash (0044), but an
    // email is the one place a bad link is most costly: it is authenticated by
    // our own DKIM signature, so a link out of a Sahaba Club email carries the
    // club's reputation with it.
    const url = safeUrl(data.href);

    return {
      subject: title || "A reminder from Sahaba Club",
      html: renderEmail({
        preheader: body || title || "Something with a deadline needs your attention.",
        eyebrow: "Reminder",
        title: title || "A reminder from Sahaba Club",
        blocks: [
          p(who ? `Hi ${who.split(/\s+/)[0]},` : "Hi,"),
          body ? p(body) : raw(""),
        ],
        cta: url ? { label: "Open it in Sahaba Club", url } : undefined,
        footerReason:
          "You are getting this because it has a deadline attached. You can turn these off under " +
          "Notifications in your settings.",
      }),
    };
  }

  // "event_reminder" — two hours before an event the member said they'd attend.
  //
  // ⚠ WHY THIS IS NOT JUST `notification`, given the note above argues for one
  // template across the deadline kinds. Two reasons, and neither is cosmetic:
  // it sends from a DIFFERENT ADDRESS (events@, Ahmed's ask), and it is the
  // only one of them a member is likely to act on within the hour, so the
  // when/where has to survive a glance on a phone rather than sit inside a
  // sentence. That is what panel() is for, and it is why this template has one
  // and `notification` does not.
  //
  // ⚠ THE WORDS STILL COME FROM ONE PLACE. `title`, `body` and `href` are
  // written by sweep_event_reminders() in 0065 and are the SAME strings the
  // member sees in the app — this template lays them out, it does not restate
  // them. That is what keeps the email and the notification from ever telling
  // somebody two different things about the same event. If the time or the
  // venue is wrong here, it is wrong in the sweep; fix it there.
  //
  // ⚠ Every value is escaped by the builders: the event title is typed by staff
  // or produced by the AI importer, and the venue comes from whatever the
  // organiser published.
  if (template === "event_reminder") {
    const who = String(data.fullName ?? "").trim();
    const title = String(data.title ?? "").trim();
    const body = String(data.body ?? "").trim();
    const url = safeUrl(data.href);

    return {
      subject: title || "An event you're going to starts soon",
      html: renderEmail({
        preheader: body || `${title} starts in about two hours.`,
        eyebrow: "Starts in two hours",
        title: title || "An event you're going to starts soon",
        blocks: [
          p(who ? `Hi ${who.split(/\s+/)[0]},` : "Hi,"),
          // The sweep writes `body` as the when and where in the event's own
          // time zone (0067). It is one sentence, and it is the thing somebody
          // glances at on a phone — so it goes in the panel, not a paragraph.
          body ? panel([{ label: "Details", value: body }]) : raw(""),
          p(
            "You told us you're going, so here's your nudge. If your plans have changed you can " +
              "say so on the event page — it only affects what we send you.",
          ),
        ],
        cta: url ? { label: "Open the event", url } : undefined,
        footerReason:
          "You are getting this because you marked yourself as going. Reminders like this can be " +
          "turned off under Notifications in your settings.",
      }),
    };
  }

  // "welcome" — sent once, the first time a member reaches onboarding.
  //
  // ⚠ Every link is absolute and points at a page that is actually live.
  // PromptArena is deliberately absent because it is hidden until its challenge
  // bank is seeded, and a welcome email that opens with a dead link is worse
  // than one that says less.
  //
  // `data.fullName` is a member's own name off their profile, escaped like
  // everything else: it is not a string this codebase generated.
  const who = String(data.fullName ?? "").trim();
  const first = who ? who.split(/\s+/)[0] : "";
  return {
    subject: "Welcome to Sahaba Club",
    html: renderEmail({
      preheader: "Your membership is live — here's what it gets you and where to start.",
      eyebrow: "Welcome",
      title: first ? `You're in, ${first}.` : "You're in.",
      blocks: [
        lead("Here's what membership gets you, and the two things worth doing today."),
        subhead("What's included"),
        bullets([
          {
            title: "Microsoft 365, free for 3 months",
            text: "your own @sahabaclub.com mailbox, Office in the browser, 1 TB of OneDrive and Teams.",
          },
          {
            title: "Events and workshops",
            text: "online and in person across the Gulf and North Africa.",
          },
          {
            title: "EduHackAI hackathons",
            text: "four rounds run so far, and round 5 is open for registration.",
          },
          {
            title: "The member directory",
            text: "so you can find people building the same things you are.",
          },
          {
            title: "The podcast and newsletter",
            text: "conversations with people in the field, tailored to the interests on your profile.",
          },
        ]),
        subhead("Two things worth doing today"),
        p(
          "Finish your profile — it is what we match coaches, events and introductions against, " +
            "so a thin one gets thin results.",
        ),
        // ⚠ This is the single most common support question, so it is a callout
        // rather than a clause: members cannot find themselves in Connect and
        // assume the directory is broken.
        callout(
          "Add a picture.",
          "Connect only lists members who have one — it is the most common reason people cannot " +
            "find themselves in the directory.",
        ),
        p("Any questions, just reply to this email."),
      ],
      cta: { label: "Open your dashboard", url: "/app/dashboard.html" },
      footerReason: "You are getting this because you just joined Sahaba Club.",
    }),
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
      // Per-template sender, falling back to the club address. See
      // FROM_BY_TEMPLATE — today only the event reminder differs.
      from: FROM_BY_TEMPLATE[template as TemplateName] ?? RESEND_FROM,
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
