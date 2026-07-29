// Microsoft Graph — app-only auth + the handful of calls Sahaba Club's
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
export const MS365_DOMAIN = Deno.env.get("MS365_DOMAIN") ?? "sahabaclub.com";

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getGraphToken(): Promise<string> {
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

export function randomTempPassword(): string {
  // Meets Azure AD's default complexity requirements; the account holder
  // never actually needs to remember this — forceChangePasswordNextSignIn
  // makes them set their own the moment they sign in.
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return `Sc-${b64.slice(0, 14)}!1`;
}

// Turns "Ahmed Abdel Razek" into a candidate mailbox local-part, then
// appends a numeric suffix if that's already taken.
export async function findAvailableMailbox(fullName: string): Promise<string> {
  const base = (fullName || "member")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .join(".") || "member";

  for (let suffix = 0; suffix < 50; suffix++) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const mailbox = `${candidate}@${MS365_DOMAIN}`;
    const existing = await graphFetch(
      `/users?$filter=mail eq '${mailbox}' or userPrincipalName eq '${mailbox}'&$select=id`,
    );
    if (!existing.value || existing.value.length === 0) return mailbox;
  }
  throw new Error("Could not find an available mailbox after 50 attempts");
}

export async function createMailbox(mailbox: string, displayName: string) {
  const tempPassword = randomTempPassword();
  const localPart = mailbox.split("@")[0];
  const user = await graphFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      accountEnabled: true,
      displayName: displayName || localPart,
      mailNickname: localPart,
      userPrincipalName: mailbox,
      passwordProfile: {
        password: tempPassword,
        forceChangePasswordNextSignIn: true,
      },
    }),
  });
  if (LICENSE_SKU_ID) {
    await assignLicense(user.id);
  }
  return { userId: user.id, mailbox, tempPassword };
}

export async function resetMailboxPassword(mailbox: string) {
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

export async function assignLicense(userId: string) {
  if (!LICENSE_SKU_ID) return;
  await graphFetch(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: JSON.stringify({
      addLicenses: [{ skuId: LICENSE_SKU_ID }],
      removeLicenses: [],
    }),
  });
}

export async function removeAllLicenses(userId: string) {
  const user = await graphFetch(`/users/${userId}?$select=assignedLicenses`);
  const skuIds = (user.assignedLicenses ?? []).map((l: { skuId: string }) => l.skuId);
  if (skuIds.length === 0) return;
  await graphFetch(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: JSON.stringify({ addLicenses: [], removeLicenses: skuIds }),
  });
}

export async function disableAccount(userId: string) {
  await graphFetch(`/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ accountEnabled: false }),
  });
}

export async function deleteAccount(userId: string) {
  await graphFetch(`/users/${userId}`, { method: "DELETE" });
}
