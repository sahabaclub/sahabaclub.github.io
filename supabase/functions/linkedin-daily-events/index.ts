// linkedin-daily-events
// ------------------------------------------------------------
// Posts the day's events to the Sahaba Club LinkedIn page, once a day.
//
// Ahmed, 11 Aug 2026, with three decisions taken at the same time:
//
//   * EVERY published event dated today, whoever runs it — which is how the
//     site already positions itself ("hackathons, meetups and conferences from
//     across the AI universe"). Most days then have something to say.
//   * ONE DIGEST a day, not one post per event. Three posts in a morning reads
//     as spam on a company page; one is a rhythm a page can keep.
//   * Nothing at all on a day with no events. A post that says "no events
//     today" is a post that teaches people to stop reading.
//
// ---- What this can and cannot do without LinkedIn ---------------------
//
// ⚠ IT IS DISARMED UNTIL A TOKEN EXISTS, AND THAT IS NOT A BUG. Posting as an
// organisation needs LinkedIn's Community Management API, which is an approval
// LinkedIn grants to an app, not something code can arrange. Until
// LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORG_URN are set, every run composes the
// post, records what it would have said, and returns it with
// `armed: false`. Nothing is lost by running it in that state — the record is
// the useful half on day one, and it means the composition is proven long
// before the credential arrives. See section 7 of SETUP.md.
//
// ---- The day ----------------------------------------------------------
//
// ⚠ "TODAY" IS ASIA/DUBAI, NOT UTC, AND THE DIFFERENCE IS NOT THEORETICAL.
// The club is in Dubai (UTC+4) and `events.event_date` is a plain date written
// by somebody thinking in local time. A job that asks UTC for the date will,
// for the four hours after 20:00 Dubai, be a day behind — and if the schedule
// ever moves to the evening it would post yesterday's events every night. The
// date is computed from a formatter pinned to the club's zone.
//
// Secrets (see section 7 of SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   LINKEDIN_ACCESS_TOKEN   — optional until the app is approved; disarmed without it
//   LINKEDIN_ORG_URN        — e.g. urn:li:organization:1234567
//   LINKEDIN_API_VERSION    — optional, the YYYYMM version header; see below
//
//   POST /linkedin-daily-events?dry=1     compose and show, write nothing
//   POST /linkedin-daily-events           the real run, once per day
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LINKEDIN_TOKEN = Deno.env.get("LINKEDIN_ACCESS_TOKEN") ?? "";
const LINKEDIN_ORG_URN = Deno.env.get("LINKEDIN_ORG_URN") ?? "";

// ⚠ LinkedIn's REST API is VERSIONED BY MONTH and the header is mandatory. A
// version that has fallen out of support is refused outright, so this is a
// secret rather than a constant: it will need changing on a cadence LinkedIn
// sets and this project does not control. The default below is a starting
// point, not a promise — confirm it against LinkedIn's own version list when
// the token is first set, which is the moment somebody is looking anyway.
const LINKEDIN_API_VERSION = Deno.env.get("LINKEDIN_API_VERSION") ?? "202505";

const SITE = "https://www.sahabaclub.ai";
const CLUB_TZ = "Asia/Dubai";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The club's own calendar date. `en-CA` because it formats as YYYY-MM-DD,
// which is what `events.event_date` holds.
function clubToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLUB_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${d} ${months[m - 1]} ${y}`;
}

type EventRow = {
  slug: string;
  title: string;
  time_label: string | null;
  mode: string | null;
  location: string | null;
  country: string | null;
  price_label: string | null;
};

// ---- The post ---------------------------------------------------------
//
// Plain text with line breaks, which is all a LinkedIn post is. No hashtag
// wall: three tags that describe the club read better than twelve that chase
// an algorithm, and the page's audience is already the people who follow it.
//
// ⚠ EVERY EVENT GETS ITS SAHABA CLUB LINK, not the organiser's ticket page.
// The point of the post is to bring people to the club's own calendar, where
// the event sits next to forty others; the organiser's link is one click
// further on and always there.
// ⚠ ESCAPING IS APPLIED PER FRAGMENT, NOT TO THE FINISHED POST, and the first
// draft of this file got it wrong in two ways that a whole-body pass cannot
// avoid:
//
//   * It escaped the `#` in the hashtags, which turns "#AI" from a hashtag
//     into the literal characters. The whole point of putting them there is
//     that LinkedIn makes them links.
//   * It would escape `_` and `~` inside the event URLs. Today's slugs are
//     lowercase and hyphenated so nothing breaks, but a slug is generated from
//     a title and the day one arrives with an underscore, every link in that
//     post is silently corrupt.
//
// So the rule is: text a human or an organiser wrote gets escaped; the URLs
// and the hashtag line are ours, contain no reserved characters, and are
// assembled afterwards untouched.
//
// ⚠ VERIFY ON THE FIRST REAL POST. This is the one part of the file that
// cannot be proven without a live token, and a wrong escape shows up as stray
// backslashes in a published post rather than as an error. The dry run returns
// the exact string that would be sent, for precisely this reason.
function escapeText(text: string): string {
  return String(text ?? "").replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => "\\" + c);
}

function composePost(day: string, events: EventRow[]): string {
  const count = events.length;
  const heading = count === 1
    ? `One AI event today · ${escapeText(longDate(day))}`
    : `${count} AI events today · ${escapeText(longDate(day))}`;

  const lines = events.map((e) => {
    const where = e.mode === "Online"
      ? "Online"
      : [e.location, e.country].filter(Boolean).join(", ") || (e.mode ?? "");
    const facts = [e.time_label, where, e.price_label].filter(Boolean).join(" · ");
    return [
      `▸ ${escapeText(e.title)}`,
      facts ? `   ${escapeText(facts)}` : "",
      `   ${SITE}/event.html?e=${encodeURIComponent(e.slug)}`,
    ].filter(Boolean).join("\n");
  });

  return [
    heading,
    "",
    lines.join("\n\n"),
    "",
    `The full calendar: ${SITE}/events.html`,
    "",
    "#AI #TechCommunity #SahabaClub",
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);

    // ---- Who may run this ----
    //
    // ⚠ Two callers, deliberately: the scheduler holds the service role key,
    // and a human wants to press it by hand to see a dry run. `refresh-avatars`
    // learned this the hard way — it accepted the service key ONLY, and that
    // value is injected by Supabase and appears on no dashboard page, so a
    // staff member pasting the key they could see got 403 for ever with no
    // clue why. So: the service key, or a real staff session.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace("Bearer ", "").trim();
    if (!bearer) return json({ error: "Not signed in" }, 401);

    if (bearer !== SERVICE_ROLE_KEY) {
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);
      // is_staff() reads auth.uid(), which is null on the admin client — it has
      // to be asked as the caller.
      const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: isStaff, error: gateError } = await asCaller.rpc("is_staff");
      if (gateError) {
        console.error("linkedin-daily-events: is_staff failed: " + gateError.message);
        return json({ error: "Could not check permissions" }, 500);
      }
      if (isStaff !== true) {
        console.error(`linkedin-daily-events: non-staff ${userData.user.id} attempted a run`);
        return json({ error: "Not allowed" }, 403);
      }
    }

    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const day = params.get("date") || clubToday();

    // ---- What is on today ----
    const { data: rows, error: evErr } = await admin
      .from("events")
      .select("slug, title, time_label, mode, location, country, price_label")
      .eq("is_published", true)
      .eq("event_date", day)
      .order("time_label", { ascending: true, nullsFirst: false })
      .order("title", { ascending: true });
    if (evErr) return json({ error: evErr.message }, 500);

    const events = (rows ?? []) as EventRow[];
    const armed = Boolean(LINKEDIN_TOKEN && LINKEDIN_ORG_URN);

    // ---- Nothing on ----
    //
    // Recorded rather than returned silently, so "why was there no post on
    // Sunday" has an answer that is not a shrug.
    if (!events.length) {
      if (!dryRun) {
        await admin.from("linkedin_daily_posts")
          .upsert({ post_date: day, status: "skipped_empty", event_count: 0 },
                  { onConflict: "post_date", ignoreDuplicates: true });
      }
      return json({ ok: true, day, armed, posted: false, reason: "no events today", event_count: 0 });
    }

    const body = composePost(day, events);
    const slugs = events.map((e) => e.slug);

    if (dryRun) {
      return json({
        ok: true, day, armed, dryRun: true, posted: false,
        event_count: events.length, event_slugs: slugs,
        body,
        // Already escaped where it needs to be — composePost does it per
        // fragment. Returned under its API name so what is eyeballed here is
        // byte-for-byte what LinkedIn would receive.
        commentary_as_sent: body,
      });
    }

    // ---- Claim the day BEFORE calling LinkedIn ----
    //
    // ⚠ THIS ORDER IS THE WHOLE POINT OF THE TABLE. Claim first and a second
    // run collides on the primary key and stops; post first and a crash between
    // the post and the record means tomorrow's run has no idea today already
    // went out. There is no unsend on a company page.
    const { error: claimErr } = await admin
      .from("linkedin_daily_posts")
      .insert({
        post_date: day,
        status: armed ? "claimed" : "dry_run",
        body,
        event_slugs: slugs,
        event_count: events.length,
      });
    if (claimErr) {
      // 23505 is the unique violation, and it is the expected, healthy answer
      // to "this already ran today".
      const already = String(claimErr.code) === "23505";
      return json(
        already
          ? { ok: true, day, posted: false, reason: "already handled today" }
          : { error: claimErr.message },
        already ? 200 : 500,
      );
    }

    // ---- Not armed: the composition is recorded and that is all ----
    if (!armed) {
      return json({
        ok: true, day, armed: false, posted: false,
        reason: "LINKEDIN_ACCESS_TOKEN or LINKEDIN_ORG_URN is not set — recorded what would have been posted",
        event_count: events.length, body,
      });
    }

    // ---- Post ----
    let res: Response;
    try {
      res = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + LINKEDIN_TOKEN,
          "Content-Type": "application/json",
          "LinkedIn-Version": LINKEDIN_API_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: LINKEDIN_ORG_URN,
          commentary: body,
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      });
    } catch (netErr) {
      const message = "could not reach LinkedIn: " + String(netErr);
      await admin.from("linkedin_daily_posts")
        .update({ status: "failed", error: message }).eq("post_date", day);
      return json({ ok: false, day, posted: false, error: message }, 502);
    }

    if (!res.ok) {
      // The raw body, kept whole. LinkedIn puts the actionable sentence in
      // there — an expired token, a version no longer supported, a missing
      // scope — and each needs a different fix.
      const detail = (await res.text()).slice(0, 1000);
      await admin.from("linkedin_daily_posts")
        .update({ status: "failed", error: `${res.status}: ${detail}` }).eq("post_date", day);
      console.error(`linkedin-daily-events: LinkedIn ${res.status}: ${detail}`);
      return json({ ok: false, day, posted: false, status: res.status, error: detail }, 502);
    }

    // LinkedIn returns the new post's id in a header rather than the body.
    const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || null;
    await admin.from("linkedin_daily_posts")
      .update({ status: "posted", post_urn: urn, posted_at: new Date().toISOString() })
      .eq("post_date", day);

    return json({ ok: true, day, posted: true, event_count: events.length, post_urn: urn });
  } catch (err) {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
