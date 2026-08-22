// Sahaba Club — admin dashboard guard and shared chrome
// ------------------------------------------------------------
// Every page under app/admin/ calls requireStaff() first. It answers two
// questions — is this person signed in, and are they staff or admin — and
// sends them away if not.
//
// Worth being clear about what this is and isn't: this is a *convenience*
// gate so the wrong person sees a polite message instead of a broken page.
// It is not the security boundary. The real enforcement lives in the
// database policies (supabase/migrations/0003), which reject unauthorised
// reads and writes no matter what the browser tries. Never move a check
// out of the database and rely on this file alone.
import { supabase } from "./supabase-client.js?v=4bf9f935fb";
import { getSession } from "./auth.js?v=4bf9f935fb";

// ⚠ `section` is not optional in spirit, even though it is in code. A page
// that calls requireStaff() with no argument is asking only "may this person
// reach the admin area at all", which since 0054 is true for an Operations
// Manager on EVERY page. Pass the section key — they match the admin_sections
// table and the filenames — or the page is ungated for a role that should not
// be there.
//
// ⚠ And this is still not the security boundary. 0054's additive RLS policies
// are: a URL typed by hand gets a polite refusal from here, and a REST call
// with the same session token gets nothing from Postgres either. If you are
// ever tempted to gate something HERE alone, the answer is a policy.
export async function requireStaff(section) {
  const session = await getSession();
  if (!session) {
    window.location.href = "../../login.html";
    return null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("user_id", session.user.id)
    .maybeSingle();

  // Which sections this person may reach. Answered by the database (it only
  // ever reports on the caller), so the nav cannot drift from what the
  // policies actually allow.
  let sections = [];
  if (!error && data) {
    const res = await supabase.rpc("my_admin_sections");
    // ⚠ A FAILED READ IS NOT "NO SECTIONS". Treating an error as an empty list
    // would lock a legitimate administrator out of their own dashboard and
    // read as a permissions bug rather than a network one. On error, fall back
    // to the role check below and show the whole nav — the tables still refuse
    // anything they should.
    if (!res.error && Array.isArray(res.data)) {
      sections = res.data.map((r) => (typeof r === "string" ? r : r.my_admin_sections)).filter(Boolean);
    } else {
      sections = null;
    }
  }

  const isFullAdmin = data && ["admin", "global_admin", "staff"].includes(data.role);
  const allowedHere = section
    ? (isFullAdmin || (sections === null) || sections.includes(section))
    : (isFullAdmin || sections === null || sections.length > 0);

  // ⚠ THE ADMIN LINK SENDS EVERYONE TO `index.html`, AND NOT EVERYONE HAS
  // `overview`.
  //
  // This is the third time this project has shipped a menu entry and a page
  // that disagree about who may pass, and the first two are documented above:
  // 0054's rename hid the link from Ahmed, then a hardcoded role list hid it
  // from Ghadir. Both were fixed by making the LINK ask `my_admin_sections()`.
  //
  // That fixed the door and not the room behind it. `script.js` shows the
  // Admin link to anyone with AT LEAST ONE section — correct — while this page
  // asks for `overview` specifically, which is one of thirteen sections and is
  // granted to nobody but full staff. An Operations Manager therefore sees the
  // Admin link, clicks it, and is told "Not one of your sections" about a page
  // she never chose to visit. She has five sections and can reach all five;
  // the only thing wrong is where the front door points.
  //
  // ⚠ The refusal screen below is still right for someone who FOLLOWED a link
  // to a section that is not theirs — that message exists deliberately and is
  // not an error on their part. The entry point is different: nobody chooses
  // it, so a dead end there is the club's mistake, not the visitor's. Redirect
  // instead, to the first page their own role can actually open.
  if (
    section === HOME_SECTION && !allowedHere &&
    Array.isArray(sections) && sections.length
  ) {
    const first = firstReachableHref(sections, data && isAdminRole(data.role));
    if (first) {
      // replace(), not href: leaving the dead entry point in history means Back
      // lands on it again and bounces straight back out.
      window.location.replace(first);
      return null;
    }
  }

  if (error || !data || !allowedHere) {
    document.body.innerHTML =
      '<div style="max-width:460px;margin:16vh auto;padding:0 20px;' +
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;' +
      // Theme tokens, not fixed hexes — this used to paint near-white text
      // onto the light-mode panel, which made the message unreadable.
      'color:var(--ad-text);text-align:center;">' +
      // Two different situations, and telling them apart matters: somebody
      // with no admin access at all needs a different sentence from an
      // Operations Manager who followed a link to a section that is not hers.
      // The second is not an error on her part and should not read like one.
      (sections && sections.length
        ? '<h1 style="font-size:21px;margin:0 0 10px;">Not one of your sections</h1>' +
          '<p style="color:var(--ad-text-2);font-size:14.5px;line-height:1.6;margin:0 0 22px;">' +
          "Your role doesn't include this part of the dashboard. Everything you do have " +
          "access to is in the menu.</p>" +
          '<a href="index.html" style="color:var(--ad-violet);font-size:14.5px;">Back to the dashboard</a>'
        : '<h1 style="font-size:21px;margin:0 0 10px;">This area is for club staff</h1>' +
          '<p style="color:var(--ad-text-2);font-size:14.5px;line-height:1.6;margin:0 0 22px;">' +
          "Your account doesn't have access to the admin dashboard. If you think it should, " +
          'ask an administrator to update your role.</p>' +
          '<a href="../dashboard.html" style="color:var(--ad-violet);font-size:14.5px;">Back to my dashboard</a>') +
      "</div>";
    return null;
  }

  return {
    session,
    userId: session.user.id,
    email: session.user.email,
    fullName: data.full_name,
    role: data.role,
    // ⚠ `global_admin` must be here. Before 0054 this read `role === "admin"`,
    // and 0054 relabels every admin to global_admin — leaving it alone would
    // have quietly hidden the Newsletter tool from the only person who has it.
    isAdmin: data.role === "admin" || data.role === "global_admin",
    // null means "could not determine" — renderShell shows everything in that
    // case rather than an empty menu, and the database still refuses whatever
    // it should.
    sections,
  };
}

// The section the Admin link lands on. Named rather than spelled inline so the
// redirect above and the nav entry below cannot drift apart, and so
// tools/check-admin-entry.mjs has something to assert against.
const HOME_SECTION = "overview";

function isAdminRole(role) {
  return role === "admin" || role === "global_admin";
}

// The first page in MENU ORDER that this person can actually open. Menu order,
// not the order `my_admin_sections()` returned, so the page they land on is the
// same one sitting at the top of their own sidebar — arriving somewhere that is
// not the first thing in the menu reads as a glitch.
function firstReachableHref(sections, isAdmin) {
  for (const item of SECTIONS) {
    if (item.group || !item.href || !item.section) continue;
    if (item.section === HOME_SECTION) continue;
    if (item.adminOnly && !isAdmin) continue;
    if (item.soon) continue;
    if (sections.includes(item.section)) return item.href;
  }
  return null;
}

// One nav definition shared by every admin page, so adding a section means
// touching one place. `adminOnly` sections are hidden from staff entirely —
// they'd be rejected by the database anyway, but showing someone a button
// that always fails is worse than not showing it.
const SECTIONS = [
  { group: "Run the club" },
  { href: "index.html", label: "Overview", section: "overview" },
  { href: "members.html", label: "Members", section: "members" },
  { href: "events.html", label: "Events", section: "events" },
  // Directly under Events because it is the other half of the same screen:
  // an event picks its organizers from this list, and nothing else can create
  // one or give it a logo. Staff and admin both, on the same reasoning as
  // everything else in this group — `organizers` is public-read and
  // staff-write through RLS (0048), so this entry decides what somebody is
  // shown and Postgres decides what they may write.
  { href: "organizers.html", label: "Organizers", section: "organizers" },
  // Next to Events because that is what it is about, and above the contact
  // lists because it is the only one of them that fills up on its own: these
  // rows arrive from an anonymous public form with nobody watching. Staff and
  // admin both — a lead nobody reads is a lead wasted, and the table behind it
  // is is_staff()-gated in the database either way (0036).
  { href: "interest.html", label: "EduHackAI interest", section: "interest" },
  { href: "licences.html", label: "Microsoft 365", section: "licences" },
  { href: "contacts.html", label: "Marketing contacts", section: "contacts" },
  { href: "campaigns.html", label: "Campaigns", section: "campaigns" },
  // Staff and admin both, on the same reasoning as everything else in this
  // group: the gate is staff_send_notification's own is_staff() check, made
  // inside a security definer function, not this list. Sitting next to
  // Campaigns because that is what it is nearest to — a message going out to
  // members — while being the much smaller of the two: it writes a line into
  // people's dashboards and sends no email at all.
  { href: "notify.html", label: "Notifications", section: "notify" },
  // Staff and admin both, on the same reasoning as PromptArena and AI services
  // below — and with more riding on it, because this is the widest read and the
  // only write path into 2,200 people's contact details. It is listed here
  // rather than hidden because hiding it would be the only control, and it is
  // not the control: every table behind it is is_staff()-gated, every write
  // goes through a security definer function that checks the role itself, every
  // write is recorded by trigger, and every export is recorded by an Edge
  // Function staff cannot write to (0033).
  { href: "data.html", label: "Data", section: "data" },
  // Staff and admin both, deliberately. It carries contact details for people
  // who never signed up here, which is exactly the kind of thing staff doing
  // outreach need — and the reason every view behind it checks is_staff()
  // inside the database rather than trusting this list.
  { href: "promptarena.html", label: "PromptArena", section: "promptarena" },
  // Staff and admin both, on the same reasoning as PromptArena above: this
  // list decides what a person is shown, and the database decides what they
  // may do. Every table behind this page has RLS with is_staff(), the staff
  // grant on the version history is INSERT on five columns and nothing else,
  // and activating a prompt goes through a security definer function that
  // checks the role itself (0031).
  { href: "ai.html", label: "AI services", section: "ai" },
  { group: "Coming soon" },
  { href: "#", label: "Coaches", soon: true },
  { href: "#", label: "Bookings", soon: true },
  { href: "#", label: "Payments", soon: true },
  { group: "Tools" },
  { href: "../newsletter.html", label: "Newsletter", section: "newsletter", adminOnly: true },
];

export function renderShell(user, activeHref) {
  const side = document.getElementById("ad-side");
  if (!side) return;

  const parts = [
    '<div class="ad-brand">',
    '<img src="../../assets/logo.png" alt="Sahaba Club">',
    "<span>Admin</span>",
    "</div>",
  ];

  // ⚠ A group heading over nothing is worse than no heading. An Operations
  // Manager sees "Run the club" and two of its eleven entries; if her role
  // ever excluded a whole group, the label would sit there alone announcing a
  // section she cannot reach. So groups are emitted only once something under
  // them survives the filter.
  let pendingGroup = null;

  for (const item of SECTIONS) {
    if (item.group) {
      pendingGroup = item.group;
      continue;
    }
    if (item.adminOnly && !user.isAdmin) continue;

    // `sections === null` means the lookup failed, not that she has none —
    // show everything and let the database refuse what it should. An empty
    // menu caused by a dropped request would look exactly like a demotion.
    if (item.section && Array.isArray(user.sections) && !user.sections.includes(item.section)) {
      continue;
    }

    if (pendingGroup) {
      parts.push('<div class="ad-navlabel">' + pendingGroup + "</div>");
      pendingGroup = null;
    }

    const classes = [
      "ad-nav",
      item.href === activeHref ? "is-active" : "",
      item.soon ? "is-soon" : "",
    ].filter(Boolean).join(" ");

    parts.push(
      '<a class="' + classes + '" href="' + item.href + '">' +
      '<span class="ad-nav-dot"></span>' +
      "<span>" + item.label + "</span>" +
      (item.soon ? '<span class="ad-soon-tag">soon</span>' : "") +
      "</a>"
    );
  }

  parts.push(
    '<div class="ad-side-foot">',
    '<div class="ad-whoami">',
    "<strong>" + escapeHtml(user.fullName || user.email || "Signed in") + "</strong>",
    '<span class="ad-pill role-' + user.role + '" style="margin-top:6px;">' + user.role + "</span>",
    "</div>",
    '<a class="ad-nav" href="../dashboard.html" style="margin-top:10px;padding-left:0;">' +
    '<span>&larr; My dashboard</span></a>',
    "</div>"
  );

  side.innerHTML = parts.join("");
}

export function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Dates render as "12 Aug 2026" everywhere in the dashboard — unambiguous
// for a team that may not all read the same date format.
export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function showMessage(elId, text, kind) {
  const el = document.getElementById(elId);
  if (el) el.innerHTML = '<div class="ad-msg ' + kind + '">' + escapeHtml(text) + "</div>";
}

export function clearMessage(elId) {
  const el = document.getElementById(elId);
  if (el) el.innerHTML = "";
}
