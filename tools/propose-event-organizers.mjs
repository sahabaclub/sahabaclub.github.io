// Propose an `organizer` for every event, for a human to review BEFORE anything
// is written.
//
// 38 of the 48 events carry no organizer at all (`brand` is set on 10, all
// "microsoft"), so the new Organizer filter has nothing to work with. This
// infers one, prints its reasoning per event, and emits SQL. It writes
// nothing itself — running it is safe.
//
// ============================================================
// The rule that matters: a HOST IS NOT AN ORGANIZER
// ============================================================
//
// The obvious approach — map the registration link's domain to a company — is
// wrong for more than a third of these events. luma.com (14), allevents.in (2)
// and eventbrowse.com (1) are TICKETING platforms. Anyone can list anything on
// them, so the domain says nothing about who is running the event. Seventeen
// events would have been filed under "Luma".
//
// So hosts are split into three kinds:
//
//   ORGANIZER hosts   — the company's own event platform. msevents.microsoft.com
//                       is Microsoft running its own event. Decisive.
//   COMMUNITY hosts   — meetup.com, aitinkerers.org. The community IS the
//                       organizer, whatever the topic. ⚠ This deliberately
//                       beats the title: "Regulatory Healthcare Analytics on
//                       Microsoft Fabric" on meetup.com is a community meetup
//                       ABOUT Microsoft tech, not an event BY Microsoft.
//                       Who organises is the question, not what it is about.
//   NEUTRAL hosts     — ticketing and listing platforms. Fall through to the
//                       title, then to Others.
//
// An event on its own conference domain (gitex.com, dubaiaifestival.com) is an
// independent commercial conference: Others. That is not a failure to
// classify — none of the six allowed values describes it, and inventing a
// seventh would break the filter Ahmed specified.
//
// Usage:
//   node tools/propose-event-organizers.mjs          review table
//   node tools/propose-event-organizers.mjs --sql    emit the UPDATE statements

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Read the endpoint out of the client the site itself uses, so there is one
// source of truth and this file never carries its own copy of a key.
const clientSrc = readFileSync(join(root, "lib", "supabase-client.js"), "utf8");
const URL_M = /const SUPABASE_URL = "([^"]+)"/.exec(clientSrc);
const KEY_M = /const SUPABASE_ANON_KEY = "([^"]+)"/.exec(clientSrc);
if (!URL_M || !KEY_M) {
  console.error("Could not read SUPABASE_URL / SUPABASE_ANON_KEY from lib/supabase-client.js");
  process.exit(1);
}
const [, SUPABASE_URL] = URL_M;
const [, SUPABASE_ANON_KEY] = KEY_M;

// The six values Ahmed specified. Nothing else may be produced.
const ALLOWED = ["Sahaba Club", "Microsoft", "AWS", "Google", "Community", "Others"];

const ORGANIZER_HOSTS = [
  [/(^|\.)msevents\.microsoft\.com$/, "Microsoft"],
  [/(^|\.)events\.teams\.microsoft\.com$/, "Microsoft"],
  [/(^|\.)microsoft\.com$/, "Microsoft"],
  [/(^|\.)aws\.amazon\.com$/, "AWS"],
  [/(^|\.)awsevents\.com$/, "AWS"],
  [/(^|\.)google\.com$/, "Google"],
  [/(^|\.)withgoogle\.com$/, "Google"],
  [/(^|\.)gdg\.community\.dev$/, "Google"],
  [/(^|\.)sahabaclub\.(ai|com)$/, "Sahaba Club"],
];

const COMMUNITY_HOSTS = [
  /(^|\.)meetup\.com$/,
  /(^|\.)aitinkerers\.org$/,
  /(^|\.)community\.dev$/,
];

// Ticketing and listing platforms — say nothing about who runs the event.
const NEUTRAL_HOSTS = [
  /(^|\.)luma\.com$/,
  /(^|\.)lu\.ma$/,
  /(^|\.)allevents\.in$/,
  /(^|\.)eventbrowse\.com$/,
  /(^|\.)eventbrite\.(com|co\.uk)$/,
];

// Only consulted for neutral hosts and missing links. Ordered: the first match
// wins, so the most specific vendor names come first.
const TITLE_RULES = [
  [/\bsahaba\b|\beduhack/i, "Sahaba Club"],
  [/\baws\b|amazon web services/i, "AWS"],
  [/\bgoogle\b|\bgdg\b|\bgemini\b|\bvertex ai\b/i, "Google"],
  [/\bmicrosoft\b|\bazure\b|\bcopilot\b|\bfabric\b|\bpower platform\b/i, "Microsoft"],
  [/\bmeetup\b|\bcommunity\b|\buser group\b|\btinkerers\b/i, "Community"],
];

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return null;
  }
}

function classify(event) {
  const host = hostOf(event.register_link);
  const hay = `${event.title || ""} ${event.description || ""}`;

  // An organizer already recorded on the row wins over any guess.
  if (event.brand && /microsoft/i.test(event.brand)) {
    return { organizer: "Microsoft", why: `brand column already says "${event.brand}"`, confident: true };
  }

  if (host) {
    for (const [re, org] of ORGANIZER_HOSTS) {
      if (re.test(host)) return { organizer: org, why: `${host} is ${org}'s own event platform`, confident: true };
    }
    for (const re of COMMUNITY_HOSTS) {
      if (re.test(host)) {
        return { organizer: "Community", why: `${host} is community-organised (topic ignored on purpose)`, confident: true };
      }
    }
    const neutral = NEUTRAL_HOSTS.some((re) => re.test(host));
    if (!neutral) {
      return { organizer: "Others", why: `${host} is the event's own domain — an independent conference`, confident: true };
    }
    for (const [re, org] of TITLE_RULES) {
      if (re.test(hay)) return { organizer: org, why: `${host} is a ticketing site; title names ${org}`, confident: false };
    }
    return { organizer: "Others", why: `${host} is a ticketing site and the title names no organizer`, confident: false };
  }

  for (const [re, org] of TITLE_RULES) {
    if (re.test(hay)) return { organizer: org, why: `no registration link; title names ${org}`, confident: false };
  }
  return { organizer: "Others", why: "no registration link and no organizer in the title", confident: false };
}

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/events?select=id,title,brand,register_link,description&order=title&limit=500`,
  { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
);
if (!res.ok) {
  console.error(`Could not read events: HTTP ${res.status}`);
  process.exit(1);
}
const events = await res.json();

const decided = events.map((e) => ({ ...e, ...classify(e) }));

for (const d of decided) {
  if (!ALLOWED.includes(d.organizer)) {
    console.error(`BUG: produced "${d.organizer}", which is not one of the six allowed values`);
    process.exit(1);
  }
}

if (process.argv.includes("--sql")) {
  console.log("-- GENERATED by tools/propose-event-organizers.mjs — review the table output first.");
  for (const d of decided) {
    console.log(`update public.events set organizer = '${d.organizer}' where id = '${d.id}';`);
  }
  process.exit(0);
}

const byOrg = {};
for (const d of decided) (byOrg[d.organizer] = byOrg[d.organizer] || []).push(d);

console.log(`${decided.length} events classified\n`);
for (const org of ALLOWED) {
  const list = byOrg[org] || [];
  if (!list.length) continue;
  const unsure = list.filter((d) => !d.confident).length;
  console.log(`\n=== ${org} — ${list.length} event(s)${unsure ? `, ${unsure} needing your eye` : ""} ===`);
  for (const d of list) {
    console.log(`  ${d.confident ? "  " : "? "} ${d.title.slice(0, 54).padEnd(56)} ${d.why}`);
  }
}

const unsure = decided.filter((d) => !d.confident);
console.log(`\n${decided.length - unsure.length} confident, ${unsure.length} marked "?" — those are guesses from the title`);
console.log("Nothing has been written. Re-run with --sql to emit the UPDATE statements.");
