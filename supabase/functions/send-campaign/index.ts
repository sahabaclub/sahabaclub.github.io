// send-campaign
// ------------------------------------------------------------
// Sends the drafts a human has already approved. Nothing else.
//
// This is a separate function from write-contact-email because generating and
// sending are separate decisions, and from send-transactional-email because
// that one is service-role-only — it takes an arbitrary `to` address, so it
// deliberately cannot be reached from a browser at all. This one can be
// called by staff, so it never takes an address as input: it only ever mails
// the address stored on a recipient row that is already marked 'approved'.
//
// Sends in batches. A 900-person campaign is many calls, and that is the
// right shape: it means a mistake noticed after the first fifty costs fifty
// emails, not nine hundred.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   RESEND_API_KEY, RESEND_FROM
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <members@sahabaclub.com>";
const SITE = "https://www.sahabaclub.ai";

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;

// ============================================================
// Claiming, and why selecting is not enough
// ============================================================
//
// ⚠ THE SELECT BELOW USED TO BE THE WHOLE OF IT: `status = 'approved'`, limit
// 25, then send. Nothing marked those rows as spoken for, so two invocations
// overlapping by even a second — an impatient second click, a retry after a
// slow response, the admin screen's own loop racing itself — both read the same
// 25 rows and both mailed them. Every person in that batch gets the letter
// twice, and the only trace is a `sent_at` that was overwritten.
//
// The fix is `promptarena-judge`'s: claim first, in a guarded UPDATE, and work
// only from the rows the database says you won. `status` moves
// approved → sending → sent/failed/skipped, and the UPDATE that sets 'sending'
// is guarded on the row still being 'approved'. Two workers issue that UPDATE
// against the same row; Postgres serialises them; the second matches nothing
// and is handed back a shorter list. It cannot mail what it did not win.
//
// The stale escape is not optional, for the same reason it is not optional
// there. A function killed between claiming and sending leaves a row 'sending'
// with nothing coming, and without this that person is never mailed again by
// anybody. Ten minutes is comfortably longer than a batch can take — the whole
// invocation dies at 150s — so a worker that is still running is never robbed
// of a row it is part-way through.
//
// ⚠ The window this leaves is the honest one, and it is a re-send of at most
// ONE letter: a row claimed, handed to Resend, and the process killed before
// the 'sent' write lands. Ten minutes later it is reclaimed and sent again.
// Closing that needs an idempotency key on the Resend call, which is a change
// to how every send is made rather than to how rows are picked.
const CLAIM_STALE_MS = 10 * 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "Not signed in" }, 401);

    // ⚠ The gate is the `campaigns` SECTION, not a list of role names. See the
    // long note in `import-event` — this is the same defect, found in the same
    // hour, and this one is the more expensive of the two: `campaigns.html`
    // admits anyone holding the section (`requireStaff("campaigns")`), and a
    // campaign is created the instant the button is pressed and CANNOT BE
    // DELETED. A role list here would have let Ghadir build a campaign she was
    // then refused permission to send, with no way to clear it up.
    //
    // `has_admin_section()` short-circuits on `is_staff()`, so everyone who
    // passed before still passes. It must be asked as the CALLER: it reads
    // `auth.uid()`, which is null on the service-role client above.
    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: allowed, error: gateError } = await asCaller.rpc("has_admin_section", {
      p_section: "campaigns",
    });
    if (gateError) {
      console.error("send-campaign: has_admin_section failed: " + gateError.message);
      return json({ error: "Could not check permissions" }, 500);
    }
    if (allowed !== true) {
      console.error(`send-campaign: user ${userData.user.id} has no campaigns section`);
      return json({ error: "You don't have the Campaigns section — ask an administrator." }, 403);
    }

    if (!RESEND_API_KEY) {
      return json({ error: "Email sending isn't configured. Set RESEND_API_KEY." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const campaignId: string | undefined = body.campaignId;
    const test: boolean = body.test === true;
    const batch = Math.min(Math.max(Number(body.limit) || DEFAULT_BATCH, 1), MAX_BATCH);
    if (!campaignId) return json({ error: "campaignId is required" }, 400);

    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, name, from_name, from_email, reply_to, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (!campaign) return json({ error: "Campaign not found" }, 404);
    if (campaign.status === "cancelled") {
      return json({ error: "This campaign was cancelled." }, 409);
    }

    // ============================================================
    // Test send
    // ============================================================
    //
    // A test goes to addresses the sender names and nobody else. It consumes
    // nothing: no recipient's status moves, no unsubscribe token is spent, and
    // the real audience is untouched however many times it is pressed.
    //
    // ⚠ EACH ADDRESS GETS ITS OWN PERSON'S DRAFT WHERE ONE EXISTS. Ahmed's
    // ask, and it is the whole point: these drafts are written per contact, so
    // sending "the first one" to three inboxes proves the template renders and
    // tells you nothing about what any actual recipient will read. Typing
    // Ghadir's address sends GHADIR'S draft, personalised from her row.
    //
    // ⚠ An address with no draft in this campaign is NOT silently given
    // somebody else's. It falls back to a sample and the response says so, per
    // address — because a test that quietly shows you the wrong person's copy
    // is worse than one that admits it is a stand-in.
    if (test) {
      // Up to three, because this accepts an arbitrary `to` and sends from a
      // domain the club has spent DNS records establishing as its own. The cap
      // and the staff gate above are what keep that from being a mailer for
      // strangers; see the same argument at the head of
      // send-transactional-email.
      const MAX_TEST = 3;
      const raw: unknown = (body as { testTo?: unknown }).testTo;
      const asked = (Array.isArray(raw) ? raw : typeof raw === "string" ? String(raw).split(/[\s,;]+/) : [])
        .map((a) => String(a ?? "").trim())
        .filter(Boolean);

      // No addresses named keeps the original behaviour — the button that used
      // to read "Send one to me first" still works exactly as it did.
      const wanted = asked.length ? asked : [userData.user.email ?? ""];

      const bad = wanted.filter((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
      if (bad.length) {
        return json({ error: "That doesn't look like an email address: " + bad.join(", ") }, 400);
      }
      if (!wanted[0]) {
        return json({ error: "Your account has no email address to send a test to." }, 400);
      }
      if (wanted.length > MAX_TEST) {
        return json({ error: `A test goes to at most ${MAX_TEST} addresses at a time.` }, 400);
      }

      // One fallback draft, fetched once, for any address that is not in this
      // campaign.
      const { data: sample } = await admin
        .from("campaign_recipients")
        .select("subject, body_text")
        .eq("campaign_id", campaignId)
        .in("status", ["generated", "approved"])
        .limit(1)
        .maybeSingle();
      if (!sample) return json({ error: "No drafts to preview yet." }, 400);

      const sent: Array<{ to: string; personalised: boolean; subject: string }> = [];
      for (const to of wanted) {
        // ⚠ Case-insensitively, because an address typed by hand will not match
        // the case it was stored in, and a capital letter must not be the
        // difference between a personalised test and a stranger's copy.
        const { data: own } = await admin
          .from("campaign_recipients")
          .select("subject, body_text")
          .eq("campaign_id", campaignId)
          // ⚠ The column is `email`, not `recipient`. 0011 copies the address
          // onto the recipient row at resolve time so the send log survives the
          // contact being corrected or deleted.
          .ilike("email", to)
          .in("status", ["generated", "approved"])
          .limit(1)
          .maybeSingle();

        const draft = own ?? sample;
        const resp = await sendOne({
          from: fromHeader(campaign),
          replyTo: campaign.reply_to,
          to,
          // The prefix says which of the two arrived, so a test that fell back
          // is obvious in the inbox and not only in the response.
          subject: (own ? "[TEST] " : "[TEST — sample, not this address] ") + draft.subject,
          text: draft.body_text ?? "",
          // ⚠ Deliberately null. A test must not carry a working unsubscribe
          // link: clicking it would opt out a real contact on the strength of a
          // message that was never part of the campaign.
          unsubscribeToken: null,
        });
        if (!resp.ok) {
          return json({
            error: "Resend refused the test to " + to + ": " + resp.detail,
            sent,
          }, 502);
        }
        sent.push({ to, personalised: !!own, subject: draft.subject });
      }

      console.log(
        `campaign ${campaignId} test sent by ${userData.user.id} to ` +
          sent.map((s) => s.to + (s.personalised ? "" : " (sample)")).join(", "),
      );
      return json({ ok: true, test: true, to: sent.map((s) => s.to).join(", "), sent });
    }

    // Only approved drafts. 'generated' is not enough — that is the whole
    // point of the review step existing. Plus any row abandoned mid-send by a
    // worker that died; see CLAIM_STALE_MS.
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
    const claimable = `status.eq.approved,and(status.eq.sending,updated_at.lt.${staleBefore})`;

    const { data: candidates, error: cErr } = await admin
      .from("campaign_recipients")
      .select("id")
      .eq("campaign_id", campaignId)
      .or(claimable)
      // Oldest first, so repeated calls walk the list instead of re-reading
      // whatever the planner happened to return. Without an order, "the next
      // 25" is not a defined set.
      .order("created_at", { ascending: true })
      .limit(batch);
    if (cErr) return json({ error: cErr.message }, 500);

    // ⚠ The claim. Guarded on the same predicate that selected them, so a row
    // another invocation took between the two statements no longer matches and
    // is simply absent from what comes back. `.select()` returns the rows this
    // UPDATE actually changed — that, and not the read above, is the list this
    // function is allowed to mail.
    let recipients: Array<{
      id: string; contact_id: string; email: string;
      subject: string | null; body_text: string | null;
    }> = [];

    if (candidates?.length) {
      const { data: claimed, error: rErr } = await admin
        .from("campaign_recipients")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .in("id", candidates.map((c) => c.id))
        .or(claimable)
        .select("id, contact_id, email, subject, body_text");
      if (rErr) return json({ error: rErr.message }, 500);
      recipients = claimed ?? [];

      if (claimed && claimed.length < candidates.length) {
        // Not an error: another invocation is working the same campaign and
        // won those rows. Worth a line, because it is also what a double-click
        // looks like from in here.
        console.warn(
          `send-campaign: claimed ${claimed.length} of ${candidates.length} candidates ` +
            `for campaign ${campaignId} — another send is running`,
        );
      }
    }

    if (!recipients.length) {
      // Same reasoning as the count at the end: anything still 'sending'
      // belongs to a worker that has not finished, so the campaign is not.
      const { count: left } = await admin
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .in("status", ["approved", "sending"]);
      const remaining = left ?? 0;

      if (remaining === 0) {
        await admin.from("campaigns")
          .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", campaignId)
          .in("status", ["review", "sending"]);
        return json({ ok: true, sent: 0, failed: 0, remaining: 0, done: true });
      }

      // ⚠ THIS USED TO RETURN `remaining: 0, done: true` HERE TOO.
      //
      // `left` was computed correctly and used to decide whether to stamp the
      // campaign `sent` — and then thrown away, because the return was
      // unconditional. So when rows WERE left, the function still reported that
      // the campaign was finished with nothing outstanding. The page believed
      // it, printed "Done — N sent", stopped looping, and nobody pressed Send
      // again. Anyone held by a worker that died mid-batch was simply never
      // mailed, and the screen said the campaign was complete.
      //
      // Nothing is claimable but rows remain, which means another invocation
      // holds them: `claim` only takes `approved` rows and `sending` rows older
      // than CLAIM_STALE_MS, so these are inside that window. They are not lost
      // — they become claimable again when it expires — but this run cannot
      // move them and must not pretend otherwise.
      //
      // ⚠ `stalled` exists because `done: false` alone would make the page's
      // send loop spin: it breaks on `done`, so a truthful `false` with nothing
      // claimable would call this function forever, as fast as it can answer.
      // The flag says "stop looping, and this is not success".
      console.warn(
        `campaign ${campaignId}: nothing claimable but ${remaining} row(s) still approved/sending — ` +
          `held by another run, claimable again after CLAIM_STALE_MS`,
      );
      return json({ ok: true, sent: 0, failed: 0, remaining, done: false, stalled: true });
    }

    await admin.from("campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .in("status", ["review", "generating", "draft"]);

    // Re-check consent at the moment of sending. Between approval and send a
    // person can unsubscribe, and the approved draft sitting in the table
    // knows nothing about that.
    const { data: contacts } = await admin
      .from("marketing_contacts")
      .select("id, unsubscribed_at, bounced_at, is_test, email_valid, unsubscribe_token")
      .in("id", recipients.map((r) => r.contact_id));
    const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const r of recipients) {
      const c = contactById.get(r.contact_id);
      if (!c || c.unsubscribed_at || c.bounced_at || c.is_test || !c.email_valid) {
        await admin.from("campaign_recipients").update({
          status: "skipped",
          error: c?.unsubscribed_at ? "Unsubscribed before this send" : "No longer mailable",
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        skipped++;
        continue;
      }

      if (!r.subject || !r.body_text) {
        await admin.from("campaign_recipients").update({
          status: "failed", error: "Draft is empty", updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        failed++;
        continue;
      }

      const resp = await sendOne({
        from: fromHeader(campaign),
        replyTo: campaign.reply_to,
        to: r.email,
        subject: r.subject,
        text: r.body_text,
        unsubscribeToken: c.unsubscribe_token,
      });

      if (resp.ok) {
        await admin.from("campaign_recipients").update({
          status: "sent", sent_at: new Date().toISOString(), error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        sent++;
      } else {
        console.error("Resend failed for recipient " + r.id + ": " + resp.detail);
        await admin.from("campaign_recipients").update({
          status: "failed", error: resp.detail.slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        failed++;
      }
    }

    // ⚠ 'sending' counts as remaining, not as finished. Now that rows are
    // claimed, a row another invocation is part-way through is neither
    // 'approved' nor 'sent' — counting only 'approved' would let this worker
    // decide the campaign was complete while a second one still had letters in
    // its hand, stamping `sent_at` and telling the admin it was done. A row
    // genuinely abandoned in 'sending' holds the campaign open until the stale
    // reclaim picks it up and finishes it, which is the right way round.
    const { count: remaining } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["approved", "sending"]);

    if ((remaining ?? 0) === 0) {
      await admin.from("campaigns")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", campaignId);
    }

    return json({ ok: true, sent, failed, skipped, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function fromHeader(campaign: { from_name?: string; from_email?: string }) {
  if (campaign.from_name && campaign.from_email) {
    return `${campaign.from_name} <${campaign.from_email}>`;
  }
  return RESEND_FROM;
}

async function sendOne(opts: {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  text: string;
  unsubscribeToken: string | null;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const unsubUrl = opts.unsubscribeToken
    ? `${SITE}/unsubscribe.html?t=${opts.unsubscribeToken}`
    : null;

  // The footer is appended here rather than asked of the model, so it is
  // identical on every email and cannot be paraphrased away. A marketing
  // email without a working opt-out is the fastest route to a blocked domain.
  const text = unsubUrl
    ? `${opts.text}\n\n—\nYou're receiving this because you registered for a Sahaba Club event.\nUnsubscribe: ${unsubUrl}`
    : opts.text;

  const html = unsubUrl
    ? `${toHtml(opts.text)}<hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0 14px;">` +
      `<p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">` +
      `You're receiving this because you registered for a Sahaba Club event.<br>` +
      `<a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a></p>`
    : toHtml(opts.text);

  const payload: Record<string, unknown> = {
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
          `font-size:15px;line-height:1.65;color:#111827;max-width:560px;">${html}</div>`,
  };
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  // List-Unsubscribe is what makes Gmail and Outlook show their own
  // one-click unsubscribe control. People who can unsubscribe easily do that
  // instead of pressing "spam", and it is the spam presses that cost us the
  // domain.
  //
  // ⚠ THE HEADER URL IS NOT THE FOOTER URL, AND THIS IS THE FIX.
  //
  // `List-Unsubscribe-Post` means the provider **POSTs** to whatever
  // `List-Unsubscribe` names. This used to name `unsubscribe.html` — a static
  // page on GitHub Pages, which runs nothing on a POST. So the recipient's own
  // Unsubscribe button reported success, wrote nothing, and they went on
  // receiving campaigns until they pressed spam instead. Every campaign sent
  // before 9 Aug 2026 carried that.
  //
  // The header now names the `unsubscribe` Edge Function, which accepts the
  // POST and writes the row. The FOOTER link below is deliberately left
  // pointing at the page: a human clicking a link should get the confirm
  // button 0011 designed, not a silent 200. (The function redirects a GET to
  // that same page, so the two cannot drift apart.)
  const unsubPostUrl = opts.unsubscribeToken
    ? `${SUPABASE_URL}/functions/v1/unsubscribe?t=${opts.unsubscribeToken}`
    : "";

  if (unsubPostUrl) {
    payload.headers = {
      "List-Unsubscribe": `<${unsubPostUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (resp.ok) return { ok: true };
  return { ok: false, detail: resp.status + " " + (await resp.text()) };
}

// The drafts are plain text by design — they read like a person wrote them,
// not like a template. This is the minimum needed to keep the paragraphs
// apart in an HTML client.
function toHtml(text: string) {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
