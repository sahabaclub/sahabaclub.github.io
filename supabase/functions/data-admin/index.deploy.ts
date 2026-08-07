// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/csv.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// data-admin
// ------------------------------------------------------------
// Import and export for the staff data panel (`app/admin/data.html`).
//
// ============================================================
// Why an Edge Function at all
// ============================================================
//
// The page could read `marketing_contacts` straight from PostgREST and build a
// CSV in the browser — it already reads that table on `contacts.html`. It does
// not, for three reasons, and only the first is about convenience:
//
//   1. AN EXPORT MUST NOT BE ABLE TO HAPPEN WITHOUT A LOG ENTRY. Migration
//      0033 grants staff SELECT on `data_export_log` and nothing else. The
//      only writer is this function, using the service role, in the same call
//      that produces the bytes. A browser-built CSV would mean asking the
//      thing being logged to log itself.
//   2. THE IMPORT PREVIEW AND THE IMPORT COMMIT MUST PARSE THE SAME BYTES THE
//      SAME WAY. One parser, called twice, in one place — see `_shared/csv.ts`.
//      Two parsers, or one parser and a trusted browser summary, is how a
//      confirm ends up applying something the operator did not read.
//   3. `.xlsx`, if it is ever added, belongs here for the same reason as (1).
//
// ============================================================
// ⚠ WHICH KEY DOES WHAT, AND WHY THAT SPLIT
// ============================================================
//
// This function holds the service-role key, and it uses it for EXACTLY ONE
// STATEMENT: the insert into `data_export_log`. Everything else — reading the
// people tables, and every write — goes through a client built on the
// CALLER'S OWN JWT.
//
// That is not caution for its own sake. It buys three properties that a
// service-role client would destroy:
//
//   * RLS applies. A member who finds this endpoint gets nothing back, because
//     `marketing_contacts` is `is_staff()`-gated, not because this file
//     remembered to check.
//   * `is_staff()` inside migration 0033's functions sees the real caller.
//   * ⚠ `auth.uid()` INSIDE THE AUDIT TRIGGER SEES THE REAL CALLER. Running
//      an import as the service role would write 2,200 audit rows with a NULL
//      actor — an audit trail that records everything except who did it, which
//      is the one column it exists for.
//
// The role check below is therefore belt to the database's braces, and is here
// for the same reason `ai-admin` has one: to return a sentence a staff member
// can act on instead of an empty result set.
//
// ⚠ THE SERVICE-ROLE KEY IS NEVER RETURNED, LOGGED OR ECHOED, and no response
// from this function contains any secret.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — injected by Supabase
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
// ---- inlined from ../_shared/csv.ts ----
// ============================================================
// Writing
// ============================================================

// Excel's own quoting rules, which are also RFC 4180's: a field is quoted when
// it contains a comma, a quote or a line break, and an embedded quote is
// doubled. CRLF because a lone LF is read as one enormous cell by older Excel
// builds on Windows.
function csvField(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

// ============================================================
// Two different jobs, and only one of them is optional
// ============================================================
//
// ⚠ FORMULA INJECTION IS NOT A FORMATTING PREFERENCE. A cell beginning `=`,
// `+`, `-`, `@`, a tab or a carriage return is executed by Excel, LibreOffice
// and Google Sheets when the file is opened. `=cmd|'/c calc'!A1` in a member's
// `full_name` is a command that runs on the machine of whoever opens the
// export, and the fields in this dataset are typed by members into a public
// sign-up form.
//
// That guard used to sit behind `options.textSafe`, and `data-admin` — the one
// caller, the surface 2,200 people's data leaves the building through —
// defaults it OFF. So the protection existed, was off by default, and the
// default was chosen for a reason that has nothing to do with it: text-safety
// was framed as "for the round trip, not for a file somebody is going to read
// as text". That framing is right about phone numbers and wrong about
// formulas.
//
// So they are separated. `needsFormulaGuard` is applied UNCONDITIONALLY by
// `toCsv`; `needsTextSafety` keeps the phone/date/leading-zero heuristics and
// keeps the toggle, because those genuinely are about how Excel displays a
// value the reader already trusts.
function needsFormulaGuard(value: string): boolean {
  // Tab and CR are in the set because they are stripped on parse and whatever
  // follows them is then read as the leading character.
  if (!/^[=+\-@\t\r]/.test(value)) return false;

  // ⚠ `-` and `+` also begin ordinary negative and signed numbers, and this
  // guard is now unconditional — so without this line every negative number in
  // every export would be wrapped as `="-5"` and stop being a number. A plain
  // numeric literal is not a formula to any of the three spreadsheets.
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return false;

  return true;
}

// Values Excel will change the meaning of if it is allowed to guess.
//
// Deliberately generous: a false positive costs a visible `="…"` wrapper in a
// text editor, and a false negative costs a phone number. The asymmetry is the
// whole point.
function needsTextSafety(value: string): boolean {
  if (value === "") return false;

  // 0501234567 — a leading zero Excel discards.
  if (/^0\d+$/.test(value)) return true;

  // +971504216499, 971 50 421 6499, (04) 123-4567.
  if (/^\+?[\d][\d\s\-().]{5,}$/.test(value)) return true;

  // 12 or more digits: past 15 significant figures Excel switches to
  // scientific notation and then rounds. 971504216499 is 12.
  if (/^\d{12,}$/.test(value)) return true;

  // 2026-08-03, 03/08/2026, 03-08 — every one of which Excel reformats, and
  // the last of which it invents a year for.
  if (/^\d{1,4}[-/]\d{1,2}([-/]\d{1,4})?$/.test(value)) return true;

  return false;
}

function textSafeValue(value: string): string {
  return '="' + value.replace(/"/g, '""') + '"';
}

type CsvOptions = {
  // Wrap values Excel would REFORMAT — phone numbers, leading zeroes, long
  // digit strings, bare dates — so it shows them as typed. Off by default: it
  // is for the round trip, not for a file somebody is going to read as text.
  //
  // ⚠ This does NOT control the formula guard, and used to. See
  // `needsFormulaGuard`: that one is applied to every export whatever this
  // says, because it is the difference between a badly formatted cell and code
  // executing on the machine of whoever opens the file.
  textSafe?: boolean;
};

function toCsv(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  options: CsvOptions = {},
): string {
  const lines: string[] = [columns.map(csvField).join(",")];

  for (const row of rows) {
    lines.push(columns.map((col) => {
      let v = formatCell(row[col]);
      // Unconditional first, then the optional display heuristics. Either way
      // the value is wrapped at most once.
      if (needsFormulaGuard(v) || (options.textSafe && needsTextSafety(v))) {
        v = textSafeValue(v);
      }
      return csvField(v);
    }).join(","));
  }

  // ⚠ THE BYTE-ORDER MARK IS NOT OPTIONAL. Without it every Arabic name in
  // this dataset opens as mojibake, and the person who opens the file has no
  // way to tell that from the database being wrong.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// How each Postgres type arrives over PostgREST, and what it should look like
// in a cell. Arrays are semicolon-separated because a comma inside a CSV cell
// is a quoting problem for no benefit, and because a member's skills are read
// back by splitting on the same character.
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// ============================================================
// Reading
// ============================================================

// A real parser rather than `split(",")`, because these files come back from
// Excel with quoted fields, embedded commas in company names, embedded
// newlines in notes, and doubled quotes inside both.
//
// Returns rows as objects keyed by the header row, with the header trimmed and
// lowercased so `Email`, `email` and ` EMAIL ` are the same column. Values are
// returned as trimmed strings; every interpretation of them happens in the
// database, in `admin_coerce_value`, so that the panel and a psql session
// cannot disagree about what "03/08/2026" means.
type ParsedCsv = {
  headers: string[];
  rows: Array<Record<string, string>>;
  // Rows whose field count did not match the header. Reported rather than
  // padded: a row with the wrong number of fields usually means a quote was
  // left open somewhere above it, and silently padding hides which row.
  ragged: Array<{ line: number; fields: number }>;
};

function parseCsv(text: string): ParsedCsv {
  // Strip the BOM we (and Excel) write. Left in place it becomes part of the
  // first header name, so `email` arrives as `﻿email` and matches nothing.
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    // ⚠ A quote only OPENS a field when it is the first character of that
    // field. Anywhere else it is a literal quote.
    //
    // This is Excel's own tolerance and it is not pedantry. RFC 4180 says a
    // field containing a quote must itself be quoted, so `=""0501…""` is the
    // only correct spelling of our Excel-safety wrapper — but hand-edited and
    // script-generated files routinely write the bare `="0501234567"` instead.
    // Treating that opening `"` as the start of a quoted section silently ate
    // the wrapper: `="0501234567"` came out as `=0501234567`, which then failed
    // to match the unwrap in `admin_coerce_value` and would have been stored,
    // literally, as somebody's phone number. Caught by the harness, not by
    // reading.
    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; endRecord(); i++; continue; }
    if (ch === "\n") { endRecord(); i++; continue; }

    field += ch; i++;
  }

  // A trailing newline leaves an empty pending record; anything else is a last
  // line without one.
  if (field !== "" || record.length > 0) endRecord();

  if (!records.length) return { headers: [], rows: [], ragged: [] };

  const headers = records[0].map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];
  const ragged: Array<{ line: number; fields: number }> = [];

  for (let r = 1; r < records.length; r++) {
    const cells = records[r];

    // Excel adds a blank line at the end of everything it saves.
    if (cells.length === 1 && cells[0].trim() === "") continue;

    if (cells.length !== headers.length) ragged.push({ line: r + 1, fields: cells.length });

    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      row[headers[c]] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }

  return { headers, rows, ragged };
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// The two tables the panel manages. `ms365_accounts`, `prospect_profiles` and
// `contact_engagements` are deliberately absent — migration 0033's header
// argues each exclusion.
const DATASETS: Record<string, { key: string; label: string }> = {
  marketing_contacts: { key: "id", label: "Marketing contacts" },
  profiles: { key: "user_id", label: "Members" },
};

// PostgREST puts `?key=in.(…)` in the URL, and a few hundred uuids is already
// a URL long enough for a proxy to refuse. Fetched in slices and stitched.
const KEY_CHUNK = 200;

// One page of a `select` without an explicit range. Used when exporting a
// whole table rather than a chosen list.
const PAGE = 1000;

// A cap with a reason rather than a round number: 5,000 is comfortably more
// than every contact and every member together, so hitting it means something
// has gone wrong with the request rather than that the club has grown.
const MAX_ROWS = 5000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SERVICE_ROLE_KEY || !ANON_KEY) return json({ error: "Not configured" }, 503);

    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);

    const { data: callerProfile } = await admin
      .from("profiles").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff" && callerProfile.role !== "global_admin")) {
      console.error(`user ${userData.user.id} attempted to reach data-admin`);
      return json({ error: "Club staff only" }, 403);
    }

    // Everything from here on runs as the caller. See the header.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + jwt } },
    });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "").trim();
    const dataset = String(body?.dataset ?? "").trim();

    if (!DATASETS[dataset]) {
      return json({ error: `Unknown dataset "${dataset}". Expected marketing_contacts or profiles.` }, 400);
    }

    if (action === "export") {
      return await runExport(caller, admin, dataset, body, userData.user, callerProfile.role);
    }
    if (action === "import_preview") return await runImport(caller, dataset, body, true);
    if (action === "import_commit") return await runImport(caller, dataset, body, false);

    return json({ error: "Unknown action. Expected 'export', 'import_preview' or 'import_commit'." }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

// ============================================================
// Export
// ============================================================
//
// ⚠ THE DEFAULT IS THE FILTERED VIEW, NOT THE TABLE. The page sends the exact
// list of keys it is showing, and this function fetches those and nothing
// else. That is a deliberate design choice over "send me the filter and I will
// re-run it": a filter re-implemented on this side would drift from the one on
// screen, and the first time it drifted the operator would export a different
// set of people from the one they were looking at without any sign of it.
//
// `scope: "all"` skips the key list and takes the whole table. It is a
// separate, deliberate act in the UI and it is recorded as such in the log.
async function runExport(
  caller: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createClient>,
  dataset: string,
  body: Record<string, unknown>,
  user: { id: string; email?: string },
  role: string,
): Promise<Response> {
  const keyCol = DATASETS[dataset].key;
  const scope = body?.scope === "all" ? "all" : "filtered";
  const textSafe = body?.text_safe === true;
  const filterLabel = String(body?.filter_label ?? "").slice(0, 300);

  // ⚠ The column list is checked against the field catalogue rather than
  // trusted. Not because a staff member cannot read these tables — they can —
  // but because an uncatalogued column is one nobody decided to expose, and
  // this is the surface where 2,200 people's data leaves the building.
  const { data: fields, error: fErr } = await caller
    .from("data_admin_fields").select("column_name").eq("table_name", dataset);
  if (fErr) return json({ error: "Couldn't read the field catalogue: " + fErr.message }, 500);

  const allowed = new Set((fields ?? []).map((f: { column_name: string }) => f.column_name));
  allowed.add(keyCol);

  const asked: string[] = Array.isArray(body?.columns) ? (body.columns as string[]).map(String) : [];
  const unknown = asked.filter((c) => !allowed.has(c));
  if (unknown.length) {
    return json({ error: "Not exportable: " + unknown.join(", ") + ". Only catalogued fields can leave." }, 400);
  }

  // ⚠ THE KEY IS ALWAYS IN THE FILE, FIRST, AND IT IS NOT OPTIONAL. Without it
  // the file cannot be edited and imported back — the importer keys contacts on
  // `id` precisely so that correcting somebody's email address updates them
  // instead of creating a second copy of them. See migration 0033 §6.
  const columns = [keyCol, ...asked.filter((c) => c !== keyCol)];
  if (columns.length === 1) {
    return json({ error: "Choose at least one column to export." }, 400);
  }

  let rows: Array<Record<string, unknown>> = [];

  if (scope === "all") {
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await caller
        .from(dataset).select(columns.join(",")).order(keyCol).range(from, from + PAGE - 1);
      if (error) return json({ error: "Couldn't read " + dataset + ": " + error.message }, 500);
      rows = rows.concat(data ?? []);
      if (!data || data.length < PAGE) break;
    }
  } else {
    const keys: string[] = Array.isArray(body?.keys) ? (body.keys as string[]).map(String) : [];
    if (!keys.length) {
      return json({ error: "Nothing to export — the list you are looking at is empty." }, 400);
    }
    if (keys.length > MAX_ROWS) {
      return json({ error: `That is ${keys.length} rows; this refuses more than ${MAX_ROWS} at once.` }, 400);
    }
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await caller
        .from(dataset).select(columns.join(",")).in(keyCol, keys.slice(i, i + KEY_CHUNK));
      if (error) return json({ error: "Couldn't read " + dataset + ": " + error.message }, 500);
      rows = rows.concat(data ?? []);
    }
  }

  const csv = toCsv(columns, rows, { textSafe });
  const bytes = new TextEncoder().encode(csv).length;

  // ⚠ THE LOG IS WRITTEN BEFORE THE FILE IS RETURNED, AND A FAILURE TO LOG IS A
  // FAILURE TO EXPORT. The other order — send the file, then log — means a
  // logging fault silently converts a recorded egress into an unrecorded one,
  // which is the exact failure this table exists to make impossible. Staff
  // hold no INSERT here, so this is the only writer.
  const { error: logErr } = await admin.from("data_export_log").insert({
    actor_id: user.id,
    actor_email: user.email ?? null,
    actor_role: role,
    dataset,
    format: "csv",
    scope,
    filter_label: filterLabel || (scope === "all" ? "the whole table" : "the current view"),
    columns,
    row_count: rows.length,
    byte_count: bytes,
    // Derived here rather than taken from the caller: what is in the file is a
    // fact about the file, not something the requester gets to assert.
    includes_email: columns.some((c) => /email|mailbox/i.test(c)),
    includes_phone: columns.some((c) => /phone/i.test(c)),
  });
  if (logErr) {
    console.error("data_export_log insert: " + logErr.message);
    return json({
      error: "The export could not be recorded, so it was not produced: " + logErr.message,
      code: "export_not_logged",
    }, 500);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return json({
    ok: true,
    filename: `sahaba-${dataset.replace(/_/g, "-")}-${stamp}.csv`,
    csv,
    row_count: rows.length,
    byte_count: bytes,
    columns,
    text_safe: textSafe,
  });
}

// ============================================================
// Import
// ============================================================
//
// This function parses and nothing else. Every decision about what a row means
// — which existing person it is, what would change, what conflicts with
// something a member wrote, and what must be rejected — is made by
// `public.admin_import_rows` in migration 0033, called with the caller's JWT.
//
// That is deliberate and it is the answer to "why is the interesting half in
// SQL". The plan has to be computed by the same code that applies it, against
// the same rows, in the same transaction semantics. Computing it here and
// applying it there would give two implementations of one rule, and the first
// time they disagreed the preview would be a lie.
async function runImport(
  caller: ReturnType<typeof createClient>,
  dataset: string,
  body: Record<string, unknown>,
  dryRun: boolean,
): Promise<Response> {
  const text = String(body?.csv ?? "");
  if (!text.trim()) return json({ error: "That file is empty." }, 400);
  if (text.length > 8_000_000) {
    return json({ error: "That file is larger than 8 MB. Split it." }, 400);
  }

  const parsed = parseCsv(text);
  if (!parsed.headers.length) return json({ error: "No header row — the first line must name the columns." }, 400);
  if (!parsed.rows.length) return json({ error: "That file has a header and no rows." }, 400);
  if (parsed.rows.length > MAX_ROWS) {
    return json({ error: `That is ${parsed.rows.length} rows; this refuses more than ${MAX_ROWS} at once.` }, 400);
  }

  const keyCol = DATASETS[dataset].key;
  if (!parsed.headers.includes(keyCol) && !(dataset === "marketing_contacts" && parsed.headers.includes("email"))) {
    return json({
      error: dataset === "marketing_contacts"
        ? "This file has no `id` column and no `email` column, so there is nothing to match its rows on. Export the list first and edit that file."
        : "This file has no `user_id` column. Members are matched on `user_id` and nothing else — export the list first and edit that file.",
    }, 400);
  }

  const options = (body?.options ?? {}) as Record<string, unknown>;

  const { data, error } = await caller.rpc("admin_import_rows", {
    p_table: dataset,
    p_rows: parsed.rows,
    p_dry_run: dryRun,
    p_options: options,
    p_expected_hash: dryRun ? null : String(body?.plan_hash ?? ""),
  });

  if (error) {
    // A refused RPC here is almost always 0033 not being applied, or a member
    // who is not staff. Both deserve their own sentence rather than a raw
    // Postgres string.
    if (/does not exist/i.test(error.message)) {
      return json({ error: "The import functions are missing — migration 0033 has not been applied yet." }, 503);
    }
    return json({ error: error.message }, 400);
  }

  return json({
    ok: true,
    ...(data as Record<string, unknown>),
    // Reported alongside the plan rather than folded into it: a ragged row
    // usually means an unterminated quote further up the file, and the row it
    // is reported against is the one to go and look at.
    ragged: parsed.ragged,
    headers: parsed.headers,
    parsed_rows: parsed.rows.length,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
