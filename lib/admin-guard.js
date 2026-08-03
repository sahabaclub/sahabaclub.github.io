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
import { supabase } from "./supabase-client.js";
import { getSession } from "./auth.js";

export async function requireStaff() {
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

  if (error || !data || (data.role !== "admin" && data.role !== "staff")) {
    document.body.innerHTML =
      '<div style="max-width:460px;margin:16vh auto;padding:0 20px;' +
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;' +
      // Theme tokens, not fixed hexes — this used to paint near-white text
      // onto the light-mode panel, which made the message unreadable.
      'color:var(--ad-text);text-align:center;">' +
      '<h1 style="font-size:21px;margin:0 0 10px;">This area is for club staff</h1>' +
      '<p style="color:var(--ad-text-2);font-size:14.5px;line-height:1.6;margin:0 0 22px;">' +
      "Your account doesn't have access to the admin dashboard. If you think it should, " +
      'ask an administrator to update your role.</p>' +
      '<a href="../dashboard.html" style="color:var(--ad-violet);font-size:14.5px;">Back to my dashboard</a>' +
      "</div>";
    return null;
  }

  return {
    session,
    userId: session.user.id,
    email: session.user.email,
    fullName: data.full_name,
    role: data.role,
    isAdmin: data.role === "admin",
  };
}

// One nav definition shared by every admin page, so adding a section means
// touching one place. `adminOnly` sections are hidden from staff entirely —
// they'd be rejected by the database anyway, but showing someone a button
// that always fails is worse than not showing it.
const SECTIONS = [
  { group: "Run the club" },
  { href: "index.html", label: "Overview" },
  { href: "members.html", label: "Members" },
  { href: "events.html", label: "Events" },
  { href: "licences.html", label: "Microsoft 365" },
  { href: "contacts.html", label: "Marketing contacts" },
  { href: "campaigns.html", label: "Campaigns" },
  // Staff and admin both, on the same reasoning as PromptArena and AI services
  // below — and with more riding on it, because this is the widest read and the
  // only write path into 2,200 people's contact details. It is listed here
  // rather than hidden because hiding it would be the only control, and it is
  // not the control: every table behind it is is_staff()-gated, every write
  // goes through a security definer function that checks the role itself, every
  // write is recorded by trigger, and every export is recorded by an Edge
  // Function staff cannot write to (0033).
  { href: "data.html", label: "Data" },
  // Staff and admin both, deliberately. It carries contact details for people
  // who never signed up here, which is exactly the kind of thing staff doing
  // outreach need — and the reason every view behind it checks is_staff()
  // inside the database rather than trusting this list.
  { href: "promptarena.html", label: "PromptArena" },
  // Staff and admin both, on the same reasoning as PromptArena above: this
  // list decides what a person is shown, and the database decides what they
  // may do. Every table behind this page has RLS with is_staff(), the staff
  // grant on the version history is INSERT on five columns and nothing else,
  // and activating a prompt goes through a security definer function that
  // checks the role itself (0031).
  { href: "ai.html", label: "AI services" },
  { group: "Coming soon" },
  { href: "#", label: "Coaches", soon: true },
  { href: "#", label: "Bookings", soon: true },
  { href: "#", label: "Payments", soon: true },
  { group: "Tools" },
  { href: "../newsletter.html", label: "Newsletter", adminOnly: true },
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

  for (const item of SECTIONS) {
    if (item.group) {
      parts.push('<div class="ad-navlabel">' + item.group + "</div>");
      continue;
    }
    if (item.adminOnly && !user.isAdmin) continue;

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
