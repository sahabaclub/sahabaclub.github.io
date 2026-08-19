// check-unsubscribe-endpoint — the one-click unsubscribe path, exercised.
//
// ⚠ WHY THIS EXISTS. Every campaign sent before 9 Aug 2026 advertised
// `unsubscribe.html` in its List-Unsubscribe header — a static page on GitHub
// Pages. Gmail and Outlook POST to that header. A POST to a static host runs
// nothing, so the recipient's own Unsubscribe button reported success, wrote
// nothing, and they kept receiving campaigns until they pressed "spam" instead.
// That is the outcome the header exists to prevent and the one that costs the
// sending domain its reputation.
//
// Nothing about that failure was visible. The button looked like it worked.
//
// The live half of this file needs no secret and writes nothing: it uses a
// token that cannot exist, so every request is a no-op on the database.
//
// ERRORS fail the build. There are no warnings here — every check in this file
// is either "one-click still works" or "one-click is silently dead".

import { readFileSync } from "node:fs";

const FUNCTIONS = "https://sobxhcsgtimtiqtvqbag.supabase.co/functions/v1/unsubscribe";
const SITE = "https://www.sahabaclub.ai";

// ⚠ A uuid that gen_random_uuid() will not produce. It is correctly SHAPED, so
// it gets past the endpoint's uuid guard and exercises the real code path, but
// its random bits are all zero — odds of collision with a live token are 2^-122.
// Using a real token here would unsubscribe a real person every time CI ran.
const DEAD_TOKEN = "00000000-0000-4000-8000-000000000000";

const errors = [];
const err = (m) => errors.push(m);
const ok = [];

// ── the live endpoint ─────────────────────────────────────────────────────
// An unreachable endpoint is a FAILURE, not a pass. A check that reports
// success because the network was down is the thing this file exists to stop.
async function call(method, url, label) {
  try {
    const r = await fetch(url, {
      method,
      redirect: "manual",
      ...(method === "POST" ? { body: "List-Unsubscribe=One-Click" } : {}),
    });
    return { status: r.status, location: r.headers.get("location") };
  } catch (e) {
    err(`${label}\n          could not reach the unsubscribe endpoint — treat as UNVERIFIED: ${String(e).slice(0, 60)}`);
    return null;
  }
}

// 1. A GET must redirect a human to the confirm page and MUST NOT unsubscribe.
//    A link that acts on being followed is a link that mail scanners and link
//    previewers will trigger on the recipient's behalf.
{
  const r = await call("GET", `${FUNCTIONS}?t=${DEAD_TOKEN}`, "GET with a token");
  if (r) {
    if (r.status !== 302) {
      err(`GET with a token returned ${r.status}, expected 302.\n          A person who opens the link instead of posting to it must reach the confirm page.`);
    } else if (r.location !== `${SITE}/unsubscribe.html?t=${DEAD_TOKEN}`) {
      err(`GET redirected to "${r.location}".\n          Expected ${SITE}/unsubscribe.html?t=<token> — the token must survive the redirect or the confirm page has nothing to act on.`);
    } else {
      ok.push("GET redirects to the confirm page with the token intact");
    }
  }
}

// 2. ⚠ THE ONE THAT MATTERS MOST. The caller is Google's or Microsoft's mail
//    infrastructure. It has no Supabase token and never will. This request
//    carries no Authorization header on purpose: if the gateway's JWT check is
//    ever turned back on for this function, this returns 401 and every
//    one-click unsubscribe in the world silently stops being recorded.
{
  const r = await call("POST", `${FUNCTIONS}?t=${DEAD_TOKEN}`, "one-click POST");
  if (r) {
    if (r.status === 401 || r.status === 403) {
      err(`one-click POST returned ${r.status} with no Authorization header.\n          THE FUNCTION IS REQUIRING A JWT. Mail providers do not have one, so every\n          Gmail/Outlook unsubscribe is now being rejected and recorded nowhere.\n          Redeploy with --no-verify-jwt.`);
    } else if (r.status !== 200) {
      err(`one-click POST returned ${r.status}, expected 200.\n          Providers retry on errors and eventually give up; the opt-out is lost.`);
    } else {
      ok.push("one-click POST is accepted with no Authorization header");
    }
  }
}

// 3. It must not become an oracle. A different answer for "no such token"
//    would let anyone test whether a token is real.
{
  const bad = await call("POST", `${FUNCTIONS}?t=not-a-uuid`, "POST with a malformed token");
  const none = await call("POST", FUNCTIONS, "POST with no token");
  for (const [r, what] of [[bad, "a malformed token"], [none, "no token at all"]]) {
    if (r && r.status !== 200) {
      err(`POST with ${what} returned ${r.status}, expected 200.\n          Answering differently turns this endpoint into a test for which tokens exist.`);
    }
  }
  if (bad && none && bad.status === 200 && none.status === 200) {
    ok.push("real, fake and malformed tokens are indistinguishable");
  }
}

// ── the source that decides which URL the emails advertise ────────────────
// The live checks above prove the endpoint is healthy. They cannot prove the
// emails point AT it — that is a string in send-campaign, and getting it wrong
// is the original bug. ⚠ Read with CRLF normalised: this repo has mixed line
// endings per file, and a bare \n needle has silently matched nothing before.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

{
  const src = read("supabase/functions/send-campaign/index.ts");

  // The HEADER must name the function. This is the whole bug.
  if (!src.includes("${SUPABASE_URL}/functions/v1/unsubscribe?t=")) {
    err(`send-campaign no longer builds the List-Unsubscribe URL from the Edge Function.\n          If this points at a static page again, one-click silently stops working.`);
  } else {
    ok.push("List-Unsubscribe names the Edge Function, not a static page");
  }

  // Without the -Post header the provider shows no button at all.
  if (!src.includes('"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"')) {
    err(`send-campaign no longer sets List-Unsubscribe-Post.\n          Without it Gmail and Outlook do not show their own unsubscribe control.`);
  } else {
    ok.push("List-Unsubscribe-Post is set, so providers show the control");
  }

  // The FOOTER link is for humans and correctly points at the page.
  if (!src.includes("${SITE}/unsubscribe.html?t=")) {
    err(`send-campaign no longer links the footer to ${SITE}/unsubscribe.html.\n          That is the link a person clicks; it must reach the confirm page.`);
  } else {
    ok.push("the footer link sends a human to the confirm page");
  }
}

{
  // A GET that writes would let scanners unsubscribe people. Guard the guard.
  const src = read("supabase/functions/unsubscribe/index.ts");
  if (!src.includes('req.method === "GET"') || !src.includes("status: 302")) {
    err(`the unsubscribe function no longer redirects GET without acting.\n          A link that unsubscribes on being followed will be triggered by mail scanners.`);
  } else {
    ok.push("GET is answered with a redirect, never a write");
  }

  // The confirm page needs a way to actually record the opt-out.
  const page = read("unsubscribe.html");
  if (!page.includes("unsubscribe_by_token")) {
    err(`unsubscribe.html no longer calls unsubscribe_by_token.\n          The page would confirm to the reader and record nothing — the original failure.`);
  } else {
    ok.push("the confirm page calls unsubscribe_by_token");
  }
}

// ── report ────────────────────────────────────────────────────────────────
for (const line of ok) console.log("  ok    " + line);
if (errors.length) {
  console.error(`\n  ${errors.length} problem(s):`);
  for (const e of errors) console.error("  FAIL  " + e);
  console.error("\n  A broken unsubscribe is invisible: the reader is told it worked, keeps");
  console.error("  receiving mail, and reaches for 'spam' instead. That is what costs the domain.");
  process.exit(1);
}
console.log("\n  one-click unsubscribe works: no JWT required, GET never writes, and the emails point at the function.");
