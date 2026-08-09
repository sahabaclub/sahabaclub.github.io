// unsubscribe
// ------------------------------------------------------------
// The endpoint the campaign emails have been advertising and did not have.
//
// `send-campaign` sets both headers RFC 8058 requires for one-click:
//
//   List-Unsubscribe: <url>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
//
// The second one changes what the first MEANS. With it present, Gmail and
// Outlook show their own Unsubscribe control and, when it is pressed, they
// **POST** to that URL — server to server, with no browser, no cookies and no
// JavaScript. The URL used to be `unsubscribe.html`, a static page on GitHub
// Pages. A POST to a static host runs nothing.
//
// ⚠ SO THE MAIL CLIENT REPORTED SUCCESS AND NOTHING WAS EVER RECORDED. The
// recipient believed they had unsubscribed, kept receiving campaigns, and the
// next control they reached for was "spam" — which is the exact outcome the
// header exists to prevent, and the one that costs the sending domain its
// reputation. Every campaign sent so far carried this.
//
// ============================================================
// Why this is a function and not a page
// ============================================================
//
// A POST has to be answered by something that can run code and write to the
// database. That is this. The friendly confirm page still exists and is still
// correct — see below for how both are served from one URL.
//
// ⚠ DEPLOYED WITH --no-verify-jwt, and it has to be. The caller is Google's or
// Microsoft's mail infrastructure, which has no Supabase token and never will.
// With the gateway's JWT check on, every one-click unsubscribe would be
// rejected before this code ran — the same shape of failure as the notification
// senders on 7 Aug.
//
// ⚠ THE TOKEN IS THE ONLY CREDENTIAL, and that is by design (0011). It is a
// uuid, it is not the address, it identifies exactly one contact row, and the
// only thing it can do is set `unsubscribed_at`. There is nothing to escalate
// to: `unsubscribe_by_token` is SECURITY DEFINER, takes a uuid, returns a bare
// boolean, and touches one column. A guessed token unsubscribes a stranger,
// which is a nuisance and not a breach — and the alternative, asking a mail
// provider to authenticate, is not available.
//
// ⚠ IT MUST BE IDEMPOTENT AND MUST NOT LEAK. Providers retry. Answering 200 to
// a token that was already used, and 200 to a token that never existed, is
// deliberate: a different answer for "no such token" turns this into an oracle
// for testing whether a token is real. The body says nothing either.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Where a HUMAN should end up. The same URL serves both audiences: a mail
// provider POSTs and gets a bare 200; a person clicking the link in a client
// that simply opens it gets sent to the page with the confirm button, which is
// the flow 0011 designed and which still works.
const SITE = (Deno.env.get("SITE_URL") ?? "https://www.sahabaclub.ai").replace(/\/+$/, "");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ⚠ CORS on a public endpoint, and it is not decoration. Gmail POSTs to this
// from its own servers, where CORS does not apply — so the function worked
// without these headers and could not be exercised from a browser at all,
// which meant the only way to prove a real token writes the row was to
// unsubscribe somebody by hand from a terminal. A public endpoint whose only
// credential is a token that already travels in plain sight inside every email
// loses nothing by being callable from a page.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  // `t` is what the emails already use; `token` accepted as a courtesy in case
  // a client rewrites it.
  const token = (url.searchParams.get("t") ?? url.searchParams.get("token") ?? "").trim();

  // ---- A person, not a provider -------------------------------------------
  //
  // Some clients open the List-Unsubscribe URL in a browser instead of posting
  // to it. Those people get the page they expect rather than a blank 200, and
  // — importantly — nothing is unsubscribed on a GET. A link that acts on being
  // followed is a link that mail scanners and link previewers will trigger on
  // the recipient's behalf.
  if (req.method === "GET" || req.method === "HEAD") {
    return new Response(null, {
      status: 302,
      headers: { ...cors, Location: `${SITE}/unsubscribe.html${token ? "?t=" + encodeURIComponent(token) : ""}` },
    });
  }

  if (req.method !== "POST") {
    return new Response("", { status: 405, headers: { ...cors, Allow: "GET, POST" } });
  }

  // ⚠ Answered 200 whatever happens next. See the header: a provider that gets
  // an error will retry, and a body that distinguishes outcomes tells an
  // attacker which tokens are real. The console is where the truth goes.
  const ok = new Response("", { status: 200, headers: cors });

  if (!SERVICE_ROLE_KEY) {
    console.error("unsubscribe: SUPABASE_SERVICE_ROLE_KEY is not set — a real unsubscribe was DROPPED");
    return ok;
  }
  if (!UUID.test(token)) {
    console.error("unsubscribe: POST with a token that is not a uuid");
    return ok;
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data, error } = await admin.rpc("unsubscribe_by_token", { p_token: token });
    if (error) {
      // Loud, because this is the branch where somebody asked to be left alone
      // and we failed to write it down.
      console.error("unsubscribe: rpc failed, the request was LOST: " + error.message);
      return ok;
    }
    // `false` means the token matched nothing, or the row was already
    // unsubscribed. Both are fine and neither is an error.
    console.log(`unsubscribe: one-click POST, matched=${data === true}`);
  } catch (err) {
    console.error("unsubscribe: threw, the request was LOST: " + String(err instanceof Error ? err.message : err));
  }

  return ok;
});
