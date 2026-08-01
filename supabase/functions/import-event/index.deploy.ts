// ⚠ GENERATED — do not edit. Deploy-time twin of index.ts with ../_shared/*
// inlined, because the Supabase dashboard editor cannot resolve relative
// imports outside the function directory. Edit index.ts and regenerate.
// import-event
// ------------------------------------------------------------
// Turns an event link into a draft event for the admin to review. Never
// inserts anything — the admin screen saves, after a human has looked at it.
//
// Why there is a paste fallback
// -----------------------------
// Measured against the ten sites Sahaba Club actually posts from, a plain
// server-side fetch gets:
//
//   Meetup, Luma                     full details
//   AWS Experience, Kaggle           the title and nothing else
//   LinkedIn Events                  a login wall
//   Microsoft Events, Hack2skill     an empty JavaScript shell
//
// So a link-only importer would fail on most real events. Rather than pretend
// otherwise, this returns { needsPaste: true } when what came back is too thin
// to be worth handing to a model, and the admin — who is already looking at
// the page in a browser where it renders fine — pastes the text in. That path
// works everywhere, including behind LinkedIn's login.
//
// Secrets (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL        — optional, defaults below
//   OPENAI_IMAGE_MODEL  — optional, defaults below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {  "Access-Control-Allow-Origin": "*",  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";
const IMAGE_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";

const BUCKET = "event-images";

// Matches the events table exactly, so the admin screen can hand the result
// straight to an insert once a human has approved it.
const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The event's own name, tidied of marketing filler. Never invent one." },
    description: { type: "string", description: "Two to four sentences describing what happens and who it suits. Empty string if the page says too little." },
    event_date: { type: "string", description: "Start date as YYYY-MM-DD. Empty string if the page does not state a date — never guess one." },
    time_label: { type: "string", description: "Human-readable time as shown, e.g. '6:30 PM - 9:00 PM'. Empty string if not stated." },
    location: { type: "string", description: "Venue and area, e.g. 'Gate Avenue, DIFC'. Empty string for online events or if not stated." },
    country: { type: "string", description: "Country, e.g. 'UAE'. Empty string if not stated and not inferable from the venue." },
    mode: { type: "string", enum: ["In-Person", "Online"], description: "Online covers webinars and livestreams. Anything with a physical venue is In-Person." },
    price_label: { type: "string", description: "Exactly one of 'Free' or 'Paid'. Use 'Free' when no cost is mentioned and none is implied." },
    brand: { type: "string", description: "The host organisation, e.g. 'Microsoft', 'AWS', 'Meetup'. Empty string if unclear." },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Three to six short topic tags for filtering, e.g. 'AI', 'Cloud', 'Hackathon', 'Workshop'. Title Case, no hashes.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How complete the source was. 'low' means key fields had to be left empty — the admin should check before publishing.",
    },
  },
  required: ["title", "description", "event_date", "time_label", "location", "country", "mode", "price_label", "brand", "tags", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You turn an event page into a structured record for Sahaba Club, an AI and cloud community in Dubai.

Use only what the page says. If a field is not stated, return an empty string — an event with a missing date that an admin fixes is fine; an event with an invented date is not, because it will be wrong on the public site and nobody will know why.

Dates must be YYYY-MM-DD. If the page gives a date without a year, choose the next occurrence of that date in the future rather than assuming the current year.

Tags are for filtering the events list, so keep them broad and reusable ('AI', 'Cloud', 'Hackathon', 'Workshop', 'Networking', 'Security') rather than specific to one event.

Set confidence to 'low' whenever the date or the title had to be guessed at or left empty.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }

    // Staff only. The client-side admin guard is a courtesy; this is the
    // boundary. Anyone can call an edge function with a valid member token.
    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!profile || (profile.role !== "admin" && profile.role !== "staff")) {
      return json({ error: "Staff only" }, 403);
    }

    if (!OPENAI_API_KEY) {
      return json({ error: "Event import isn't configured yet — OPENAI_API_KEY is not set." }, 503);
    }

    const body = await req.json();
    const url: string = (body.url ?? "").trim();
    const pastedText: string = (body.pageText ?? "").trim();
    const wantImage: boolean = body.generateImage !== false;

    if (!url && !pastedText) {
      return json({ error: "Give me a link, or paste the page text." }, 400);
    }

    let sourceText = pastedText;
    let ogImage = "";
    let fetchNote = "";

    if (url) {
      const page = await readPage(url);
      ogImage = page.ogImage;
      fetchNote = page.note;

      if (!pastedText) {
        // Thin means: not enough for a model to do anything but hallucinate.
        if (page.text.length < 400) {
          return json({
            needsPaste: true,
            reason: page.note ||
              "That site doesn't give a server enough to work with — it needs a logged-in browser or renders entirely in JavaScript.",
            hint: "Open the event, select all the page text, copy it, and paste it below. Everything else works the same.",
            ogImage,
          });
        }
        sourceText = page.text;
      }
    }

    const context = [
      url ? "Source URL: " + url : "",
      "",
      sourceText.slice(0, 24000),
    ].join("\n");

    const evt = await extractEvent(context);
    if ("error" in evt) return json({ error: evt.error }, 502);

    // Judge by the result, not the source. Live testing put both LinkedIn
    // events through here: the login page carries plenty of text, so the
    // length check passed, the model correctly refused to invent anything,
    // and the admin got a blank form with no explanation. An empty title
    // means the fetch found no event, whatever the byte count said — and
    // that is exactly the case the paste path exists for.
    //
    // A missing *date* is not enough to bail on: the AWS pages give a real
    // title and a real picture and only hide the date, which is worth
    // keeping and flagging rather than throwing away.
    if (!evt.title.trim() && !pastedText) {
      return json({
        needsPaste: true,
        reason: "That page loaded, but there was no event in what came back — most likely a sign-in wall.",
        hint: "Open the event, select all the page text, copy it, and paste it below. Everything else works the same.",
        ogImage,
      });
    }

    // Prefer the event's own artwork. It is accurate, it is what the organiser
    // chose, and it costs nothing — a generated picture of a Microsoft event is
    // at best decorative and at worst quietly misleading.
    let imageUrl = "";
    let imageOrigin = "none";
    if (ogImage) {
      const stored = await storeFromUrl(admin, ogImage);
      if (stored) {
        imageUrl = stored;
        imageOrigin = "source";
      }
    }
    if (!imageUrl && wantImage) {
      const generated = await generateImage(admin, evt.title, evt.tags);
      if (generated) {
        imageUrl = generated;
        imageOrigin = "generated";
      }
    }

    return json({
      ok: true,
      draft: {
        title: evt.title,
        description: evt.description,
        event_date: evt.event_date,
        time_label: evt.time_label,
        location: evt.location,
        country: evt.country,
        mode: evt.mode,
        price_label: evt.price_label,
        brand: evt.brand,
        tags: evt.tags,
        register_link: url,
        image_url: imageUrl,
      },
      confidence: evt.confidence,
      imageOrigin,
      fetchNote,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// ---- Reading the page -------------------------------------------------

async function readPage(url: string) {
  const empty = { text: "", ogImage: "", note: "" };
  let html = "";
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        // Some sites serve a stub to anything that doesn't look like a
        // browser. This is not an attempt to get past a login wall — those
        // return a login page regardless, which is what the paste path is for.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en",
      },
    });
    if (!res.ok) {
      return { ...empty, note: "The site answered with " + res.status + "." };
    }
    html = await res.text();
  } catch (err) {
    return { ...empty, note: "Couldn't reach that link: " + String(err) };
  }

  const ogImage = meta(html, "og:image") || meta(html, "twitter:image");

  // Structured data first — schema.org/Event is exactly this job, and when a
  // site publishes it the result is far better than reading prose.
  const jsonLd: string[] = [];
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html)) !== null) jsonLd.push(m[1].trim());

  const parts = [
    meta(html, "og:title") ? "Title: " + meta(html, "og:title") : "",
    meta(html, "og:site_name") ? "Site: " + meta(html, "og:site_name") : "",
    meta(html, "og:description") ? "Summary: " + meta(html, "og:description") : "",
    meta(html, "description") ? "Description: " + meta(html, "description") : "",
    jsonLd.length ? "Structured data:\n" + jsonLd.join("\n").slice(0, 12000) : "",
    "Page text:\n" + textOf(html),
  ].filter(Boolean);

  const isLoginWall = /sign in|log in|join now/i.test(html) && textOf(html).length < 1500;

  return {
    text: parts.join("\n\n"),
    ogImage,
    note: isLoginWall ? "That page is behind a sign-in wall for anyone who isn't logged in." : "",
  };
}

function meta(html: string, name: string) {
  const patterns = [
    new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', "i"),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + name + '["\']', "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return "";
}

function textOf(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim().slice(0, 20000);
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// ---- The model call ---------------------------------------------------

async function extractEvent(context: string) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      max_output_tokens: 3000,
      input: [{ role: "user", content: [{ type: "input_text", text: context }] }],
      text: { format: { type: "json_schema", name: "event", strict: true, schema: EVENT_SCHEMA } },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("OpenAI " + res.status + ": " + detail);
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      return { error: "The configured model name isn't valid. Set OPENAI_MODEL in the Edge Function secrets." };
    }
    return { error: "Couldn't read that event just now." };
  }

  const data = await res.json();
  const parts = (data.output ?? []).find((o: { type?: string }) => o.type === "message")?.content ?? [];
  if (parts.some((p: { type?: string }) => p.type === "refusal")) {
    return { error: "Couldn't read that page." };
  }
  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) return { error: "Nothing came back from the model." };
  return JSON.parse(textPart.text) as {
    title: string; description: string; event_date: string; time_label: string;
    location: string; country: string; mode: string; price_label: string;
    brand: string; tags: string[]; confidence: string;
  };
}

// ---- Images -----------------------------------------------------------

async function storeFromUrl(admin: ReturnType<typeof createClient>, src: string) {
  try {
    const res = await fetch(src);
    if (!res.ok) return "";
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\//.test(type)) return "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 5_000_000) return "";
    return await upload(admin, bytes, type.split(";")[0]);
  } catch (err) {
    console.error("source image: " + String(err));
    return "";
  }
}

async function generateImage(admin: ReturnType<typeof createClient>, title: string, tags: string[]) {
  // Deliberately abstract. Generating something that imitates a real
  // organiser's branding would put a fake Microsoft or AWS logo on the public
  // events page, which is both misleading and not ours to do.
  const prompt = [
    "Abstract editorial artwork for a technology community event card.",
    "Theme: " + [title, ...(tags || [])].join(", ") + ".",
    "Deep navy and violet with cyan accents, soft gradients, geometric shapes,",
    "subtle depth, generous negative space, modern and calm.",
    "No text, no words, no letters, no logos, no brand marks, no people's faces.",
  ].join(" ");

  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Authorization": "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: "1024x1024", n: 1 }),
    });
    if (!res.ok) {
      console.error("image " + res.status + ": " + (await res.text()));
      return "";
    }
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return await upload(admin, bytes, "image/png");
  } catch (err) {
    console.error("generate image: " + String(err));
    return "";
  }
}

async function upload(admin: ReturnType<typeof createClient>, bytes: Uint8Array, contentType: string) {
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const name = crypto.randomUUID() + "." + ext;
  const { error } = await admin.storage.from(BUCKET).upload(name, bytes, { contentType, upsert: false });
  if (error) {
    console.error("upload: " + error.message);
    return "";
  }
  return admin.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
