// ⚠ GENERATED — do not edit. Deploy-time twin of index.ts with ../_shared/*
// inlined, because the Supabase dashboard editor cannot resolve relative
// imports outside the function directory. Edit index.ts and regenerate.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---- inlined from ../_shared/graph.ts ----
// automation needs (mailbox create/reset, license assign/remove, disable,
// delete). Shared by provision-ms365 and ms365-lifecycle so there's one
// place that knows how to talk to Graph, not two slightly different ones.
//
// Requires an Azure AD app registration with admin-consented
// *application* permissions (not delegated — nothing here runs as a
// signed-in user): User.ReadWrite.All, Organization.Read.All. See
// SETUP.md for the consent walkthrough.

const TENANT_ID = Deno.env.get("MS_GRAPH_TENANT_ID") ?? "";
const CLIENT_ID = Deno.env.get("MS_GRAPH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MS_GRAPH_CLIENT_SECRET") ?? "";
const LICENSE_SKU_ID = Deno.env.get("MS_GRAPH_LICENSE_SKU_ID") ?? "";
const MS365_DOMAIN = Deno.env.get("MS365_DOMAIN") ?? "sahabaclub.com";

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`Graph token request failed: ${resp.status} ${await resp.text()}`);
  }
  const body = await resp.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function graphFetch(path: string, init: RequestInit = {}) {
  const token = await getGraphToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`Graph ${init.method ?? "GET"} ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.status === 204 ? null : resp.json();
}

function randomTempPassword(): string {
  // Meets Azure AD's default complexity requirements; the account holder
  // never actually needs to remember this — forceChangePasswordNextSignIn
  // makes them set their own the moment they sign in.
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return `Sc-${b64.slice(0, 14)}!1`;
}

// "Ahmed Abdel Razek" -> "ahmedabdelrazek". Letters and digits only: no dots,
// no spaces, no separators of any kind, per the club's naming rule. Accents
// are folded rather than dropped, so "José" becomes "jose" and not "jos".
//
// Returns "" when the name yields nothing usable — an Arabic-script name has
// no Latin characters to keep. That case is refused upstream rather than
// substituted: falling back to a generic word produced member@, member1@,
// member2@ … which are unique, meaningless, and impossible for the member or
// for staff to recognise later.
function mailboxLocalPart(fullName: string): string {
  return (fullName || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// A mailbox name has to be recognisably this person. Two characters is the
// floor — a single initial is not a name.
function isUsableMailboxName(fullName: string): boolean {
  return mailboxLocalPart(fullName).length >= 2;
}

// OData string literals escape a quote by doubling it. The local part is
// already restricted to [a-z0-9] so nothing can get through, but the domain
// comes from an env var and this keeps the query well-formed regardless.
function odata(s: string) {
  return s.replace(/'/g, "''");
}

// Is this address claimed by ANYTHING in the directory?
//
// Checking /users alone is not enough, and that is what broke provisioning:
// a *group* holding the address lets user creation succeed (the UPN is free)
// and then makes assignLicense fail, because licensing provisions an Exchange
// mailbox which tries to claim the SMTP address and collides with the group.
// The error surfaces on the licence call and reads as a licensing problem
// when it is really a naming collision.
//
// proxyAddresses matters too: an address can be a secondary alias on some
// other object without being its primary `mail`.
async function addressInUse(mailbox: string, nickname: string): Promise<boolean> {
  const m = odata(mailbox);
  const n = odata(nickname);

  const users = await graphFetch(
    `/users?$filter=userPrincipalName eq '${m}' or mail eq '${m}' or mailNickname eq '${n}'&$select=id&$top=1`,
  );
  if (users.value?.length) return true;

  // Groups and alias lookups need Group.Read.All (or Directory.Read.All) and
  // the advanced-query header. If that consent has not been granted these
  // calls 403 — which must not block provisioning, because the
  // create-then-verify path below still catches the collision. Treated as
  // "unknown, carry on" and logged loudly enough to be actionable.
  const advanced = { headers: { ConsistencyLevel: "eventual" } };
  const alias = `$filter=proxyAddresses/any(p:p eq 'SMTP:${m}')&$count=true&$top=1&$select=id`;
  for (const path of [`/groups?$filter=mail eq '${m}' or mailNickname eq '${n}'&$select=id&$top=1`,
                      `/groups?${alias}`, `/users?${alias}`]) {
    try {
      const res = await graphFetch(path, advanced);
      if (res.value?.length) return true;
    } catch (err) {
      console.warn(
        `directory lookup ${path.split("?")[0]} failed — grant Group.Read.All ` +
        `to check group and alias collisions up front: ${err}`,
      );
    }
  }
  return false;
}

// Turns a name into a free mailbox address, appending 1, 2, 3… until one is
// actually unclaimed.
async function findAvailableMailbox(fullName: string): Promise<string> {
  const base = mailboxLocalPart(fullName);
  for (let suffix = 0; suffix < 50; suffix++) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const mailbox = `${candidate}@${MS365_DOMAIN}`;
    if (!(await addressInUse(mailbox, candidate))) return mailbox;
  }
  throw new Error("Could not find an available mailbox after 50 attempts");
}

// True when Graph is telling us the address is taken by something else,
// rather than that licensing itself went wrong.
function isAddressConflict(err: unknown): boolean {
  const s = String(err);
  return /proxyAddresses already exists|ObjectConflict|ConflictingObjects|already exist/i.test(s);
}

// Where the club is based. Graph needs a country for licensing regardless of
// where the member actually lives, and the licences come from a UAE tenant.
const DEFAULT_USAGE_LOCATION = Deno.env.get("MS_GRAPH_USAGE_LOCATION") ?? "AE";

async function createMailbox(
  mailbox: string,
  displayName: string,
  usageLocation: string = DEFAULT_USAGE_LOCATION,
) {
  const tempPassword = randomTempPassword();
  const localPart = mailbox.split("@")[0];
  const user = await graphFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      accountEnabled: true,
      displayName: displayName || localPart,
      mailNickname: localPart,
      userPrincipalName: mailbox,
      // Not optional, despite Graph accepting the user without it. A licence
      // cannot be assigned to a user whose usageLocation is unset — Graph
      // rejects the assignLicense call with "Licence assignment failed because
      // the user's usage location is not set". Because that failure lands on
      // the NEXT call, the account is created first and then provisioning
      // dies, leaving an unlicensed orphan in the tenant and no
      // ms365_accounts row. Setting it here is what makes the pair atomic in
      // practice.
      usageLocation,
      passwordProfile: {
        password: tempPassword,
        forceChangePasswordNextSignIn: true,
      },
    }),
  });
  if (LICENSE_SKU_ID) {
    try {
      await assignLicense(user.id);
    } catch (err) {
      // The account exists at this point. If licensing fails we must not
      // leave it behind: an unlicensed user with no ms365_accounts row is
      // invisible to the club, unusable by the member, and still occupies
      // the name — so the next attempt collides with our own wreckage.
      try {
        await deleteAccount(user.id);
      } catch (cleanupErr) {
        console.error(
          `ORPHAN: created ${mailbox} (${user.id}) but could not license or ` +
          `delete it. Remove it by hand in Entra. ${cleanupErr}`,
        );
      }
      throw err;
    }
  }
  return { userId: user.id, mailbox, tempPassword };
}

// Create a licensed mailbox, stepping to the next candidate name whenever the
// directory says the address is taken.
//
// The up-front lookup cannot be trusted on its own: it needs Group.Read.All to
// see group and alias collisions, and that consent may not be granted. So the
// authoritative test is the attempt itself — Graph rejects the licence with an
// ObjectConflict, createMailbox removes the account it just made, and we try
// the next name. That makes provisioning correct with or without the extra
// permission, which is what stops this being a support ticket every time
// somebody's name happens to match an old distribution list.
async function provisionMailbox(fullName: string, displayName: string) {
  const base = mailboxLocalPart(fullName || displayName);
  if (base.length < 2) {
    // Refused, not substituted. See mailboxLocalPart.
    throw new Error("NAME_NOT_LATIN");
  }
  let lastErr: unknown = null;

  for (let suffix = 0; suffix < 20; suffix++) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const mailbox = `${candidate}@${MS365_DOMAIN}`;

    if (await addressInUse(mailbox, candidate)) continue;

    try {
      return await createMailbox(mailbox, displayName);
    } catch (err) {
      if (!isAddressConflict(err)) throw err;
      lastErr = err;
      console.warn(`${mailbox} is claimed elsewhere in the directory — trying the next name`);
    }
  }
  throw new Error(
    `Could not find a free mailbox name for "${displayName}" after 20 attempts. ` +
    `Last conflict: ${lastErr}`,
  );
}

async function resetMailboxPassword(mailbox: string) {
  const tempPassword = randomTempPassword();
  await graphFetch(`/users/${encodeURIComponent(mailbox)}`, {
    method: "PATCH",
    body: JSON.stringify({
      passwordProfile: {
        password: tempPassword,
        forceChangePasswordNextSignIn: true,
      },
    }),
  });
  return { mailbox, tempPassword };
}

async function assignLicense(userId: string) {
  if (!LICENSE_SKU_ID) return;
  await graphFetch(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: JSON.stringify({
      addLicenses: [{ skuId: LICENSE_SKU_ID }],
      removeLicenses: [],
    }),
  });
}

// Read-only health check. Proves the app registration, tenant id and client
// SECRET are all good, and reports how many licence seats are actually free —
// assignLicense returns 400 when a SKU has no free units, and that failure
// lands after the mailbox has already been created, so knowing the seat count
// in advance is worth a call of its own.
async function graphDiagnostics(licenseSkuId = LICENSE_SKU_ID) {
  await getGraphToken(); // throws with the AADSTS code if credentials are wrong
  const org = await graphFetch("/organization?$select=id,displayName,verifiedDomains");
  const skus = await graphFetch(
    "/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits",
  );
  const all = (skus.value ?? []).map((s: {
    skuId: string;
    skuPartNumber: string;
    prepaidUnits: { enabled: number };
    consumedUnits: number;
  }) => ({
    skuId: s.skuId,
    name: s.skuPartNumber,
    enabled: s.prepaidUnits?.enabled ?? 0,
    consumed: s.consumedUnits ?? 0,
    free: (s.prepaidUnits?.enabled ?? 0) - (s.consumedUnits ?? 0),
    isConfigured: s.skuId === licenseSkuId,
  }));
  const configured = all.find((s: { isConfigured: boolean }) => s.isConfigured) ?? null;
  return {
    tokenOk: true,
    tenant: org.value?.[0]?.displayName ?? null,
    domains: (org.value?.[0]?.verifiedDomains ?? [])
      .map((d: { name: string }) => d.name),
    configuredSkuId: licenseSkuId || null,
    configuredSku: configured,
    // Named so a missing configured SKU is obvious rather than silently null.
    configuredSkuFound: !!configured,
    allSkus: all,
  };
}

async function removeAllLicenses(userId: string) {
  const user = await graphFetch(`/users/${userId}?$select=assignedLicenses`);
  const skuIds = (user.assignedLicenses ?? []).map((l: { skuId: string }) => l.skuId);
  if (skuIds.length === 0) return;
  await graphFetch(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: JSON.stringify({ addLicenses: [], removeLicenses: skuIds }),
  });
}

async function disableAccount(userId: string) {
  await graphFetch(`/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ accountEnabled: false }),
  });
}

async function deleteAccount(userId: string) {
  await graphFetch(`/users/${userId}`, { method: "DELETE" });
}

// ---- index.ts ----
// provision-ms365
// ------------------------------------------------------------
// Called once, from app/onboarding.html, right after someone answers
// "do you already have a @sahabaclub.com account?".
//
//   { action: "create" }                       — first-timer, no mailbox yet
//   { action: "reset", mailbox: "x@sahabaclub.com" } — reclaiming an old one
//
// Either way this ends with: a mailbox that exists and is licensed, a
// fresh temporary credential (never returned to the browser — only
// emailed), and an `ms365_accounts` row the rest of the app can read.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — to write ms365_accounts
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET
//   MS_GRAPH_LICENSE_SKU_ID                  — which M365 SKU to assign
//   MS365_DOMAIN                              — defaults to sahabaclub.com
//   RESEND_API_KEY, RESEND_FROM               — for the credential email
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    // Service-role client: bypasses RLS so this function can write
    // ms365_accounts for the caller, but we still verify *who* the caller
    // is from their own JWT before doing anything on their behalf.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const user = userData.user;

    const { action, mailbox: existingMailbox, fullName: requestedName } = await req.json();
    if (action !== "create" && action !== "reset" && action !== "diagnose") {
      return json({ error: "action must be 'create', 'reset' or 'diagnose'" }, 400);
    }

    // ---- action = "diagnose" : STAFF ONLY, read-only ----
    //
    // Answers "are the Graph credentials right, and are there licence seats
    // left?" without creating, changing or deleting anything. Worth having as
    // its own action: the alternative way to find out is to run a real
    // provisioning attempt, which creates a mailbox in the tenant and burns a
    // seat just to discover a secret is wrong.
    if (action === "diagnose") {
      const { data: diagProfile } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (diagProfile?.role !== "staff" && diagProfile?.role !== "admin") {
        return json({ error: "Not allowed" }, 403);
      }
      try {
        return json({ ok: true, diagnostics: await graphDiagnostics() });
      } catch (graphError) {
        // The AADSTS code is the whole point of this call, so it is returned
        // rather than swallowed into a generic 500.
        return json({ ok: false, error: String(graphError) }, 200);
      }
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", user.id)
      .maybeSingle();

    // The member may supply a Latin spelling of their name for the mailbox.
    // It is only ever used as a name — mailboxLocalPart strips it to [a-z0-9]
    // before it reaches Graph — so there is nothing here to inject with.
    const suppliedName = typeof requestedName === "string"
      ? requestedName.trim().slice(0, 80)
      : "";
    const displayName = suppliedName || profile?.full_name || "";

    let result: { mailbox: string; tempPassword: string };
    let preExisting: boolean;

    if (action === "create") {
      // Refuse if this member already has a mailbox on record. Without this,
      // a second click mints a brand new mailbox from their name and the
      // upsert below overwrites the row pointing at the old one — so the
      // member silently loses the account they already had, and the tenant
      // keeps an orphan nobody is tracking. Someone who already has one wants
      // the linking flow, not a second address.
      const { data: already } = await admin
        .from("ms365_accounts")
        .select("mailbox")
        .eq("user_id", user.id)
        .maybeSingle();
      if (already?.mailbox) {
        return json({
          error: "You already have a Microsoft 365 account on record.",
          mailbox: already.mailbox,
          code: "already_provisioned",
        }, 409);
      }

      // A @sahabaclub.com address has to be typeable and recognisable, so the
      // name behind it must be Latin script. An Arabic-script name leaves
      // nothing to build from — that is asked for, not guessed at, and never
      // filled in from the email address, which produces things like
      // ahmedrazeknhgmailcom@sahabaclub.com.
      if (!isUsableMailboxName(displayName)) {
        return json({
          error: "We need your name in English letters to build your @sahabaclub.com address.",
          code: "name_not_latin",
        }, 400);
      }

      const created = await provisionMailbox(displayName, displayName);
      result = { mailbox: created.mailbox, tempPassword: created.tempPassword };
      preExisting = false;
    } else {
      // ---- action = "reset" : STAFF ONLY ----
      //
      // This branch resets the password of whatever mailbox it is handed and
      // emails the new one to the caller. Without the check below, any signed-in
      // member could reset the tenant Global Admin and receive the password —
      // `mailbox` comes from the request body and proves nothing about who owns it.
      //
      // Members do not reach this any more. A member who has lost their password
      // uses the flow in migration 0021: the site shows them their own mailbox,
      // they ask for a reset, and a human does it. That was a deliberate design
      // decision, not a limitation — a password reset on a real tenant mailbox
      // should have a person behind it.
      const { data: prof } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (prof?.role !== "staff" && prof?.role !== "admin") {
        console.error(`non-staff user ${user.id} attempted action=reset`);
        return json({ error: "Not allowed" }, 403);
      }

      if (!existingMailbox) return json({ error: "mailbox is required for action=reset" }, 400);
      // Second line of defence: never touch an address outside our own tenant,
      // whatever a caller asks for.
      if (!String(existingMailbox).toLowerCase().trim().endsWith(`@${MS365_DOMAIN.toLowerCase()}`)) {
        return json({ error: `mailbox must be on ${MS365_DOMAIN}` }, 400);
      }

      result = await resetMailboxPassword(String(existingMailbox).trim());
      preExisting = true;
    }

    const licenseExpiresAt = new Date();
    licenseExpiresAt.setMonth(licenseExpiresAt.getMonth() + 3);

    const { error: upsertError } = await admin.from("ms365_accounts").upsert({
      user_id: user.id,
      mailbox: result.mailbox,
      status: "active",
      pre_existing: preExisting,
      license_expires_at: licenseExpiresAt.toISOString().slice(0, 10),
      grace_ends_at: null,
      credential_sent_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;

    // Best-effort: a delivery failure here shouldn't undo the mailbox
    // that was just created — log it and let the member request a resend
    // from their dashboard later (that resend endpoint is a Phase 2 item).
    try {
      await admin.functions.invoke("send-transactional-email", {
        body: {
          to: user.email,
          template: "ms365_credential",
          data: { mailbox: result.mailbox, tempPassword: result.tempPassword, preExisting },
        },
      });
    } catch (emailError) {
      console.error("send-transactional-email failed:", emailError);
    }

    return json({ ok: true, mailbox: result.mailbox });
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
