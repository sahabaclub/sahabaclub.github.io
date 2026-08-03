// CSV, the way Excel actually behaves
// ------------------------------------------------------------
// Shared by `data-admin`'s export and import halves so that a file this
// platform produces is a file this platform can read back unchanged. That
// round trip is not a nicety here: the Microsoft 365 job is "export the people
// with no personal address, type the addresses into Excel, import it again",
// and every step of it is a place Excel can quietly corrupt the data.
//
// ============================================================
// Why CSV and not .xlsx
// ============================================================
//
// Ahmed said Excel, and Excel opens both. The difference is what they cost.
//
//   * CSV is text. It survives email, Git, a terminal, a diff, and a support
//     ticket where somebody pastes three lines of it. When an import goes
//     wrong, the file can be read by the person who made it.
//   * `.xlsx` is a zip of XML documents. Producing one means a zip writer, a
//     CRC32, a shared-string table and a worksheet schema, and reading one
//     means all of that in reverse plus a date system that counts from 1900
//     and believes 1900 was a leap year.
//
// So: CSV, and the mangling Excel does to CSV is dealt with head on rather
// than wished away. Three problems matter for THIS dataset and none of them
// are theoretical:
//
//   1. ARABIC NAMES. Without a UTF-8 byte-order mark, Excel decodes the file
//      in the machine's legacy codepage and every Arabic name becomes
//      mojibake. `toCsv` always emits the BOM.
//   2. PHONE NUMBERS AND DATES. `0501234567` becomes 501234567. `971504216499`
//      becomes 9.71504E+11. `03-08` becomes a date in the current year. None
//      of these raise an error anywhere; the number is simply wrong from then
//      on, in a file about how to contact people.
//   3. FORMULA INJECTION. A cell beginning `=`, `+`, `-`, `@`, a tab or a
//      carriage return is EXECUTED when the file is opened. These fields are
//      typed by members into a public form, so this is the one problem here
//      that somebody chooses to cause.
//
// The fix for (2) is `textSafe`: an at-risk value is written as `="0501234567"`,
// which Excel reads as the literal text and displays exactly as given.
// `admin_coerce_value` in migration 0033 unwraps it on the way back in, so the
// round trip is lossless.
//
// (3) uses the same wrapper and is NOT the same decision. It is applied to
// every export, always, with no way to turn it off — see `needsFormulaGuard`.
// It used to ride along inside `textSafe`, which meant the protection was a
// side effect of a display preference that `data-admin` leaves off by default:
// the ordinary export, the one people actually take, was the unguarded one.
//
// The honest limitation, said out loud: `="…"` is Excel-specific. A file
// opened in a plain text editor shows the wrapper. For (2) that is why it is a
// switch, and why the panel explains what it is for at the point of choosing
// it. For (3) a visible wrapper on the handful of cells that start with `=` is
// simply the price, and it is a small one.
//
// ⚠ If `.xlsx` is added later it belongs in the Edge Function, not the
// browser: the export log is written in the same call that produces the bytes,
// and moving the writer into the page would put a 2,200-row personal-data file
// together somewhere that cannot be logged.

// ============================================================
// Writing
// ============================================================

// Excel's own quoting rules, which are also RFC 4180's: a field is quoted when
// it contains a comma, a quote or a line break, and an embedded quote is
// doubled. CRLF because a lone LF is read as one enormous cell by older Excel
// builds on Windows.
export function csvField(value: string): string {
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
export function needsFormulaGuard(value: string): boolean {
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
export function needsTextSafety(value: string): boolean {
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

export function textSafeValue(value: string): string {
  return '="' + value.replace(/"/g, '""') + '"';
}

export type CsvOptions = {
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

export function toCsv(
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
export function formatCell(value: unknown): string {
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
export type ParsedCsv = {
  headers: string[];
  rows: Array<Record<string, string>>;
  // Rows whose field count did not match the header. Reported rather than
  // padded: a row with the wrong number of fields usually means a quote was
  // left open somewhere above it, and silently padding hides which row.
  ragged: Array<{ line: number; fields: number }>;
};

export function parseCsv(text: string): ParsedCsv {
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
