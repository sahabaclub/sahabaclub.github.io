-- Sahaba Club — staff control of the ongoing AI services
-- ============================================================
--
-- Ahmed: "I want to add section in the admin panel to control all the AI
-- Prompts in the website … Also to have control of which model to use for this
-- service … I need this for the continue running prompt with us, not the one
-- used to match users profile as example; any AI or prompt used in the initial
-- setup no need to have it in the dashboard."
--
-- So this file is about the AI the club keeps paying for, month after month:
-- the avatars, the CV reader, the PromptArena coach and challenge writer, the
-- member introduction, the outreach email and the event importer. It is
-- deliberately NOT about `build-prospect-profile`, which is the one-off
-- SharePoint import that matches harvested data to profiles — the exact
-- example Ahmed excluded. That function is untouched by this migration and
-- reads none of these tables.
--
-- ============================================================
-- ⚠ WHY THIS IS 0031 AND NOT 0030
-- ============================================================
--
-- 0029 is the highest migration that has been applied. There is a file called
-- `tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql`, and
-- it is a PROPOSAL awaiting a decision — that is why it sits under `tools/`
-- and not in this directory. It has never been applied anywhere.
--
-- 0030 is therefore left free so that proposal can keep its number if it is
-- accepted. Nothing is missing from the sequence; if you are reading this
-- because `select * from supabase_migrations.schema_migrations` has a hole at
-- 0030, the hole is on purpose and the file is where the paragraph above says
-- it is.
--
-- ============================================================
-- What this migration does and does not decide
-- ============================================================
--
-- It stores THREE things per service: the prompt (in editable parts), the
-- model name, and the output ceiling. It stores them as an append-only history
-- with exactly one active row, and it refuses to activate a row that has not
-- passed a real test call.
--
-- It does NOT store the code defaults. That is the single most important
-- property of the design and it is worth stating before anything else:
--
--   ⚠ EVERY SERVICE STILL RUNS ON THE PROMPT IN ITS OWN SOURCE FILE UNTIL
--     SOMEBODY ACTIVATES A VERSION HERE, AND FALLS BACK TO IT AGAIN THE MOMENT
--     THE ACTIVE VERSION IS REMOVED.
--
-- `supabase/functions/_shared/ai-config.ts` merges part by part and treats
-- anything blank, absent, malformed or unreadable as absent. Deleting every
-- row in `ai_service_versions` restores the platform to its pre-0031
-- behaviour exactly. A prompt that a member depends on can therefore be
-- broken by an edit, but it can never be made to not exist.
--
-- ============================================================
-- Security, before the tables
-- ============================================================
--
-- These tables are a live write path into a paid model call, and one of them
-- (the judge) writes numbers that appear on a leaderboard. Staff only, and
-- enforced by the database:
--
--   * RLS on every table, with `public.is_staff()` policies — the same helper
--     0003 defines and 0027 and 0029 use.
--   * Supabase grants ALL on a newly created table or view to `anon` and
--     `authenticated` by default, so every object below is REVOKED FIRST and
--     then granted narrowly. Without the revoke, the model names, the prompts
--     and the change history are world-readable the moment this applies.
--   * Every view that reads with the owner's rights (`security_invoker = off`)
--     carries `public.is_staff()` INSIDE its own body, because RLS does not
--     apply to it at all. This is the point 0029's PromptArena views make and
--     the one to re-read before editing any view here.
--   * The two functions that change what is live are `security definer` and
--     check `is_staff()` in their own bodies. `security definer` bypasses RLS,
--     so a check that is not in the function is a check that is not made.
--
-- ⚠ NO COLUMN IS ADDED TO `public.profiles` BY THIS MIGRATION, and therefore
-- no `grant update` on `profiles` is issued. 0002 revoked the table-wide
-- UPDATE and hands it back one column at a time (0005 → 0017 → 0019 → 0029);
-- adding a member-editable column without extending that list fails silently,
-- and adding a staff-only column to it would be a hole. This file needs
-- neither, because everything it stores lives in its own tables. If a later
-- change does add a column to `profiles` for this feature, it is staff-only
-- and must NOT be granted.

-- ============================================================
-- 1. The services
-- ============================================================
--
-- A "service" here is one configurable AI call site, which is not quite the
-- same as one Edge Function — and the two places they differ are both
-- deliberate:
--
--   * `generate-avatar` and `refresh-avatars` are TWO functions and ONE
--     service. `supabase/functions/_shared/avatar-art.ts` says why: "a house
--     style that exists in two copies is a house style that drifts". They
--     share the file today, and after this migration they share the row.
--     There is no per-function prompt for either of them to hold, so there is
--     nothing for the panel to accidentally split. Splitting them would mean
--     adding a second row and repointing `ai_service_functions` — a migration
--     and a code change, not a click.
--
--   * `import-event` is ONE function and TWO services. It makes a text call to
--     `/v1/responses` to read the event page, and a separate image call to
--     `/v1/images/generations` to draw the card artwork. Those are two
--     prompts, two models and two endpoints; pretending they are one setting
--     would mean either hiding the card prompt from Ahmed or offering a model
--     dropdown that is wrong for one of the two calls.
--
-- `kind` is the load-bearing column. It is what makes "a text model selected
-- for an image service" impossible rather than discouraged — see the trigger
-- in §5.

create table if not exists public.ai_services (
  slug text primary key,

  label text not null,
  blurb text not null,

  -- 'text'  → POST /v1/responses, model must be a text model
  -- 'image' → POST /v1/images/*, model must be an image model
  kind text not null check (kind in ('text', 'image')),
  endpoint text not null,

  -- The Edge Function secret this service reads when nothing is active here.
  -- Shown in the panel so "why is it still on gpt-5" has an answer that does
  -- not require reading source.
  model_env text not null,
  code_default_model text not null,

  -- ⚠ NOT a copy of the prompt. The code default lives in the function's own
  -- source file and this table deliberately does not mirror it — see the
  -- header. `parts_shape` describes the SHAPE of what is editable so the panel
  -- can render the right fields without a per-service branch:
  --
  --   [{ "key": "...", "label": "...", "kind": "text"|"list",
  --      "length": <n, list only>, "rows": <textarea rows>, "hint": "..." }]
  --
  -- `length` on a list is not cosmetic. The twelve monthly themes and the
  -- three avatar variants are ROTAS indexed by calendar month and by attempt
  -- number; a list of a different length does not mean "fewer entries", it
  -- means every index means something else. `ai-config.ts` rejects a stored
  -- list whose length disagrees and falls back to the code's.
  parts_shape jsonb not null,

  -- The tuned ceiling from the function's own source, or null for a service
  -- that sends none (the image ones) or computes it per call.
  --
  -- ⚠ This number is derived, not picked. `build-prospect-profile` failed
  -- 42.9% of live calls at a ceiling of 1500 because on the gpt-5 family
  -- `max_output_tokens` is shared with the model's own reasoning tokens and
  -- can be exhausted before the first visible character. The panel warns
  -- loudly below this value; the test run in §4 is what actually stops a bad
  -- one, because a ceiling that is too low fails the test with a truncation.
  recommended_max_output_tokens int
    check (recommended_max_output_tokens is null or recommended_max_output_tokens > 0),
  max_output_tokens_editable boolean not null default false,
  ceiling_note text not null default '',

  -- True for `promptarena-judge` only. Documents in data what §6 implements in
  -- a trigger: changing this service's configuration must move
  -- `promptarena_submissions.judge_version`.
  bumps_judge_version boolean not null default false,

  sort_order int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A service that says it has an editable ceiling must say what the tuned one
  -- was, or the panel has nothing to warn against.
  constraint ai_services_ceiling_coherent check (
    not max_output_tokens_editable or recommended_max_output_tokens is not null
  )
);

drop trigger if exists ai_services_set_updated_at on public.ai_services;
create trigger ai_services_set_updated_at
  before update on public.ai_services
  for each row execute function public.set_updated_at();

-- ---- The eight ---------------------------------------------------------
--
-- Seeded here rather than by a script so that applying this migration is the
-- whole of the setup. `on conflict do update` on the descriptive columns only:
-- re-applying must not disturb anything staff have activated, and nothing
-- staff activate lives in this table.

insert into public.ai_services
  (slug, label, blurb, kind, endpoint, model_env, code_default_model,
   parts_shape, recommended_max_output_tokens, max_output_tokens_editable,
   ceiling_note, bumps_judge_version, sort_order)
values
  (
    'avatar-art',
    'Member avatars — house style, monthly themes, three variants',
    'The illustrated portrait every member gets. One configuration shared by generate-avatar (a member drawing their own, three tries a month) and refresh-avatars (the whole wall redrawn on the new month''s theme). They share it because the pictures sit next to each other in the directory and a house style in two copies is a house style that drifts.',
    'image',
    'POST /v1/images/edits',
    'OPENAI_IMAGE_MODEL',
    'gpt-image-1',
    '[
      {"key":"house_style","label":"House style","kind":"text","rows":12,
       "hint":"Stated on every avatar, both functions. Say the style positively AND negatively — image models drift back to a glossy 3D render unless told not to twice."},
      {"key":"themes","label":"Monthly theme rota","kind":"list","length":12,"rows":2,
       "hint":"Twelve entries, January first. Indexed by calendar month, so the order is the meaning — entry 3 is what everyone regenerated in March gets. A mood and a palette accent, never a costume or a scene."},
      {"key":"variants","label":"The three variants","kind":"list","length":3,"rows":4,
       "hint":"A member''s three tries a month, in order. Accents on one identity — framing, which end of the gradient leads, how the background is handled — not three art directions. Phrase each as a refinement of the house style, never as a contradiction of it."}
    ]'::jsonb,
    null, false,
    'Image calls send no max_output_tokens. Cost is per image, at size 1024x1024 and quality high.',
    false, 10
  ),
  (
    'parse-profile-document',
    'CV and LinkedIn import',
    'Reads a member''s uploaded CV, LinkedIn export or photo of a CV and fills in their profile fields for review. Runs every time somebody joins or re-imports, which is what makes it ongoing rather than setup.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Extraction instructions","kind":"text","rows":18,
       "hint":"The country list and the tag vocabulary are appended to this at call time from the database — do not paste them in here. Strict json_schema: an instruction that contradicts the schema fails every call."}
    ]'::jsonb,
    8000, true,
    'Reasoning is capped to low effort for this one, because extracting fields off a CV has nothing to reason about. 8000 was set after 4000 starved the JSON and surfaced to members as "that document was too long".',
    false, 20
  ),
  (
    'promptarena-judge',
    'PromptArena coach — scoring and feedback',
    'Marks eight dimensions of a member''s prompt and writes the coaching. Runs on every submission, for ever. The most consequential prompt on the platform: it produces the numbers behind the leaderboard.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Judge system prompt","kind":"text","rows":26,
       "hint":"CALIBRATED against 294 real historical judgements. The rule that overrides everything — never mark a prompt down for being well written or machine-looking — is why this judge exists; the previous one scored 52 submissions that way and they average 2.94 against 5.43. Editing this bumps judge_version automatically."}
    ]'::jsonb,
    13000, true,
    'Derived, not picked: ~5,200 visible tokens (the field caps, times the Arabic token multiplier) plus ~8,000 of reasoning allowance. There is deliberately no effort dial to turn down — the reasoning IS the product here. The retry ceiling scales with this one.',
    true, 30
  ),
  (
    'promptarena-challenge',
    'PromptArena challenge writer',
    'Writes new practice challenges into the bank — the situation, the constraints and the per-challenge marking weights. Runs whenever the bank needs topping up.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Challenge writer system prompt","kind":"text","rows":26,
       "hint":"Strict json_schema, and it echoes the assigned axes back. The technique must never be named to the member — a challenge that names its own technique teaches nothing."}
    ]'::jsonb,
    null, false,
    'Computed per call from the batch size: 8,000 fixed plus 1,600 per challenge, escalating to 26,000 fixed on a truncation. Not a single number, so not editable here — change the formula in the function if it needs to move.',
    false, 40
  ),
  (
    'write-member-intro',
    'New member introduction card',
    'The two or three sentences under a new member''s name on the club feed. Runs on every member who completes their profile.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Introduction system prompt","kind":"text","rows":18,
       "hint":"Rule 2 (never name a licence tier) is checked in code as well as asked for here, and the check will reject a draft regardless of what this says. Repetition is the failure mode: these cards sit stacked on one wall."}
    ]'::jsonb,
    1200, true,
    'Two or three sentences plus a one-word tag. 1200 is generous for the visible answer; on a reasoning model most of it is reasoning.',
    false, 50
  ),
  (
    'write-contact-email',
    'Outreach email drafting',
    'Drafts one personal email per contact for a staff-reviewed campaign. Runs per campaign, in batches, indefinitely.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Email writer system prompt","kind":"text","rows":18,
       "hint":"Reads the personal details of people who are not members. Rule 2 (never name a licence tier) and the placeholder rule are both checked in code afterwards — a draft that breaks them is rejected, not sent."}
    ]'::jsonb,
    2000, true,
    'Three or four short paragraphs, a subject line and a note for the reviewer.',
    false, 60
  ),
  (
    'import-event',
    'Event importer — reading the page',
    'Turns an event link or pasted page into a draft event record for staff to review. The text half of import-event.',
    'text',
    'POST /v1/responses',
    'OPENAI_MODEL',
    'gpt-5',
    '[
      {"key":"system","label":"Event extraction prompt","kind":"text","rows":14,
       "hint":"Strict json_schema. The date rule matters more than it looks: an invented date goes onto the public events page and nobody finds out why."}
    ]'::jsonb,
    3000, true,
    'One structured event record.',
    false, 70
  ),
  (
    'import-event-card',
    'Event importer — the card artwork',
    'The abstract artwork drawn for an imported event that has no usable image of its own. The image half of import-event, and a separate service because it is a different endpoint, a different model and a different prompt.',
    'image',
    'POST /v1/images/generations',
    'OPENAI_IMAGE_MODEL',
    'gpt-image-1',
    '[
      {"key":"image_brief","label":"Card artwork brief","kind":"text","rows":10,
       "hint":"The event title and tags are appended to this at call time. Deliberately abstract: generating something that imitates a real organiser''s branding would put a fake Microsoft or AWS logo on the public events page."}
    ]'::jsonb,
    null, false,
    'Image call, no token ceiling. One image per imported event that needs one.',
    false, 80
  )
on conflict (slug) do update set
  label = excluded.label,
  blurb = excluded.blurb,
  kind = excluded.kind,
  endpoint = excluded.endpoint,
  model_env = excluded.model_env,
  code_default_model = excluded.code_default_model,
  parts_shape = excluded.parts_shape,
  recommended_max_output_tokens = excluded.recommended_max_output_tokens,
  max_output_tokens_editable = excluded.max_output_tokens_editable,
  ceiling_note = excluded.ceiling_note,
  bumps_judge_version = excluded.bumps_judge_version,
  sort_order = excluded.sort_order;

-- ============================================================
-- 2. Which Edge Function uses which service
-- ============================================================
--
-- Ten rows for eight functions and eight services, and the two places the
-- counts do not line up are the two design decisions in §1. This table is what
-- the panel shows under "used by", so a person about to edit the house style
-- can see — before they type — that they are editing both avatar functions at
-- once.
--
-- ⚠ This is also the structural guarantee that the two avatar functions cannot
-- be split apart from the admin panel. There is one `avatar-art` row in
-- `ai_services`, both functions point at it here, and neither the panel nor
-- any function granted to `authenticated` can insert into this table. Giving
-- `refresh-avatars` its own house style requires a new service row and a
-- repointed foreign key: a migration, reviewed, not a click.

create table if not exists public.ai_service_functions (
  function_name text not null,
  service_slug text not null references public.ai_services(slug) on delete restrict,
  -- What the function does with it, for the panel's "used by" line.
  usage_note text not null default '',
  primary key (function_name, service_slug)
);

insert into public.ai_service_functions (function_name, service_slug, usage_note) values
  ('generate-avatar',        'avatar-art',            'a member drawing their own, three tries per month'),
  ('refresh-avatars',        'avatar-art',            'the monthly redraw of the whole wall'),
  ('parse-profile-document', 'parse-profile-document', 'every CV or LinkedIn import'),
  ('promptarena-judge',      'promptarena-judge',     'every submission, live and on the queue drain'),
  ('promptarena-challenge',  'promptarena-challenge', 'topping up the challenge bank'),
  ('write-member-intro',     'write-member-intro',    'every completed profile'),
  ('write-contact-email',    'write-contact-email',   'every campaign batch'),
  ('import-event',           'import-event',          'reading the event page'),
  ('import-event',           'import-event-card',     'drawing the card when the page has no usable image')
on conflict (function_name, service_slug) do update set
  usage_note = excluded.usage_note;

-- ============================================================
-- 3. The models the account can actually use
-- ============================================================
--
-- ⚠ NOT A HARDCODED LIST. This table is a cache, written only by the
-- `ai-admin` Edge Function running as the service role, from OpenAI's own
-- `/v1/models` endpoint using the configured key. It is empty until somebody
-- opens the panel and refreshes it, and that is correct: a list of model names
-- written into a migration in August is a list of model names that is wrong by
-- November, and the whole point of this feature is that Ahmed does not have to
-- wait for a deploy.
--
-- The table exists rather than the panel simply rendering the API response,
-- because §5's constraint needs something to join to. "A text model cannot be
-- saved for an image service" has to be enforced where the write happens, and
-- the database cannot call OpenAI.
--
-- `kind` is the classification `ai-admin` derives from the model id — see the
-- comment there for the rule and for what happens to a family it does not
-- recognise ('other', selectable for nothing, and the fix is one line).
--
-- `available` rather than deleting: a version row in the history references
-- the model it used, and a model OpenAI stops listing must not take that
-- history with it. Refreshing marks the absent ones unavailable and leaves
-- them joinable.

create table if not exists public.ai_models (
  id text primary key,
  kind text not null check (kind in ('text', 'image', 'other')),
  owned_by text not null default '',
  released_at timestamptz,
  available boolean not null default true,
  first_seen_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
);

create index if not exists ai_models_kind_idx
  on public.ai_models (kind, id) where available;

-- ============================================================
-- 4. The history, and the one active row
-- ============================================================
--
-- Append-only. A version is never edited: a change is a new row, and a
-- rollback is a new row carrying an old row's payload (§7). 0017 makes the
-- same argument about migrations — "append-only is the only version that
-- converges" — and it applies with more force to a prompt, because the
-- question staff will actually ask is "what was it on the 14th".
--
-- ⚠ `test_status` IS THE GATE. A version is created 'untested'. Only the
-- `ai-admin` Edge Function, running as the service role, may move it — after
-- it has composed the real prompt and made one real call with the candidate
-- model and ceiling. `activate_ai_version` refuses anything that is not
-- 'passed'. Staff hold no UPDATE grant on this table at all, so this is not a
-- convention the panel follows; it is a privilege they do not have.
--
-- Why that gate and not a warning: several of these services use strict
-- `json_schema` structured outputs. A prompt edit that contradicts the schema
-- does not fail loudly — it fails on every call, silently, until a member
-- reports that their CV import stopped working. The only honest check is to
-- make the call.

create table if not exists public.ai_service_versions (
  id uuid primary key default gen_random_uuid(),
  service_slug text not null references public.ai_services(slug) on delete restrict,

  -- Assigned by the trigger below, per service, 1 upwards. Not accepted from
  -- the client: a version number a caller chooses is a version number two
  -- callers choose the same value for.
  version int not null,

  -- Only the keys named in the service's `parts_shape`. `ai-config.ts`
  -- ignores anything else, so an extra key is inert rather than dangerous —
  -- but the panel does not send one and §5 rejects one, because an inert
  -- setting that looks like it is doing something is its own kind of bug.
  parts jsonb not null default '{}'::jsonb,

  -- A real foreign key, so a model the account cannot use cannot be stored at
  -- all. `on delete restrict` protects the history; refreshes never delete.
  model text not null references public.ai_models(id) on delete restrict,

  max_output_tokens int,

  note text not null default '',

  -- Defaulted, and deliberately NOT in the column-level INSERT grant below:
  -- a change must be attributable to whoever made it, and a caller who can
  -- write this column can attribute their edit to somebody else.
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  is_active boolean not null default false,
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete set null,

  -- Set when this row was produced by rolling back to an earlier one, so the
  -- history reads as a timeline rather than as a mystery repeat.
  rolled_back_from int,

  test_status text not null default 'untested'
    check (test_status in ('untested', 'passed', 'failed')),
  tested_at timestamptz,
  -- What was actually called. Recorded separately from `model` because a test
  -- that was run against a different model than the one being saved proves
  -- nothing, and `activate_ai_version` checks they agree.
  test_model text,
  test_detail jsonb,

  -- Computed by the trigger in §6 over the whole configuration. Not writable.
  config_digest text not null default '',

  unique (service_slug, version),

  -- A hard floor and a hard ceiling, not the tuned value. The tuned value is a
  -- warning in the panel and a failure in the test run; this constraint only
  -- catches a number that could not possibly be meant — 0 (a call that costs
  -- money and returns nothing) and anything past what the API will accept.
  constraint ai_service_versions_ceiling_sane check (
    max_output_tokens is null or max_output_tokens between 256 and 128000
  ),

  -- A version cannot claim to be tested without saying when and against what.
  constraint ai_service_versions_test_coherent check (
    (test_status = 'untested' and tested_at is null and test_model is null)
    or (test_status <> 'untested' and tested_at is not null and test_model is not null)
  )
);

-- At most one active version per service. A partial unique index rather than a
-- trigger, because "exactly one" is a statement about the table and belongs in
-- the table. Zero active rows is legal and meaningful: it is the service
-- running on its code defaults.
create unique index if not exists ai_service_versions_active_idx
  on public.ai_service_versions (service_slug) where is_active;

create index if not exists ai_service_versions_history_idx
  on public.ai_service_versions (service_slug, version desc);

-- ============================================================
-- 5. What may be saved at all
-- ============================================================
--
-- Three rules, in one BEFORE INSERT trigger, because all three have to hold
-- before a row exists rather than after.

create or replace function public.ai_version_prepare()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service public.ai_services%rowtype;
  v_model public.ai_models%rowtype;
  v_key text;
  v_allowed text[];
begin
  select * into v_service from public.ai_services where slug = new.service_slug;
  if not found then
    raise exception 'Unknown AI service %', new.service_slug using errcode = '23503';
  end if;

  -- ---- 1. The model must match the endpoint --------------------------
  --
  -- ⚠ THIS IS THE RULE THAT MUST BE IMPOSSIBLE TO BREAK, NOT MERELY
  -- DISCOURAGED. `generate-avatar` and `refresh-avatars` POST multipart to
  -- /v1/images/edits; the other services POST JSON to /v1/responses. A text
  -- model on an image service is not a worse picture, it is a 400 on every
  -- call — and for the avatars that means a member watching `avatar_status`
  -- sit on 'failed' with an error they cannot act on.
  --
  -- The panel filters its dropdown by kind as well. That is the courtesy; this
  -- is the boundary.
  select * into v_model from public.ai_models where id = new.model;
  if not found then
    raise exception 'Model % is not in the model list. Refresh the model list first.', new.model
      using errcode = '23503';
  end if;
  if not v_model.available then
    raise exception 'Model % is no longer offered by this OpenAI account.', new.model
      using errcode = '23514';
  end if;
  if v_model.kind <> v_service.kind then
    raise exception
      'Model % is a % model; % is a % service calling %. Pick a % model.',
      new.model, v_model.kind, v_service.slug, v_service.kind, v_service.endpoint, v_service.kind
      using errcode = '23514';
  end if;

  -- ---- 2. The ceiling must be one this service has ------------------
  if v_service.max_output_tokens_editable then
    if new.max_output_tokens is null then
      new.max_output_tokens := v_service.recommended_max_output_tokens;
    end if;
  else
    -- A service that computes its ceiling per call, or sends none at all,
    -- must not carry a number that nothing will ever read.
    new.max_output_tokens := null;
  end if;

  -- ---- 3. Only the parts this service declares ----------------------
  --
  -- An unknown key is ignored by `ai-config.ts`, so it is harmless — which is
  -- exactly why it is rejected here instead. A stored setting that looks like
  -- it is doing something and is not is worse than a refused save.
  select array_agg(value ->> 'key') into v_allowed
    from jsonb_array_elements(v_service.parts_shape);

  if jsonb_typeof(new.parts) <> 'object' then
    raise exception 'parts must be a JSON object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(new.parts) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Service % has no editable part called "%". It has: %',
        new.service_slug, v_key, array_to_string(v_allowed, ', ')
        using errcode = '22023';
    end if;
  end loop;

  -- ---- Version numbering, assigned not accepted ---------------------
  select coalesce(max(version), 0) + 1 into new.version
    from public.ai_service_versions where service_slug = new.service_slug;

  -- ---- The digest, see §6 -------------------------------------------
  new.config_digest := public.ai_config_digest(
    new.parts, new.model, new.max_output_tokens
  );

  -- Nothing is born active or tested, whatever the caller sent.
  new.is_active := false;
  new.activated_at := null;
  new.activated_by := null;

  return new;
end;
$$;

revoke all on function public.ai_version_prepare() from public, anon, authenticated;

drop trigger if exists ai_service_versions_prepare on public.ai_service_versions;
create trigger ai_service_versions_prepare
  before insert on public.ai_service_versions
  for each row execute function public.ai_version_prepare();

-- ============================================================
-- 6. The digest, and how the judge's version bumps itself
-- ============================================================
--
-- `promptarena-judge/index.ts` carries this, above `JUDGE_VERSION`:
--
--   ⚠ Bump this whenever the dimensions, the weights, the anchors, the band
--   definitions or the system prompt change. `promptarena_submissions.
--   judge_version` exists so that "did the judge get harsher in March" can be
--   answered as "the judge changed in March" rather than guessed at — and it
--   can only answer that if this string moves when the judge does.
--
-- That instruction was written for a human editing a source file, and it held
-- because editing the judge meant a deploy. Once staff can change the judge's
-- prompt from a browser, an instruction in a comment is exactly the wrong
-- mechanism: the person making the change is not reading the file. The judge
-- itself makes the general form of this argument about its own prompt rules —
-- "a rule that lives only in a prompt is a rule that holds until the day it
-- does not" — and the same is true of a rule that lives only in a comment.
--
-- ⚠ SO THE BUMP IS DERIVED AND NOT CHOSEN. `config_digest` is the first 12
-- hex characters of an md5 over the whole configuration: the prompt parts, the
-- model, and the ceiling. The judge appends it to its own `JUDGE_VERSION`
-- constant, so a stored version produces e.g. `2026-08-02.1+9f3c1a4b2d0e`.
-- There is no code path in the judge that can decline to move it, because it
-- does not compute it.
--
-- Two properties that follow, both wanted:
--
--   * Changing EITHER the prompt OR the model moves it. `judge_model` records
--     the model separately, but a model change is a judge change and the
--     column that answers "were these two months comparable" has to say no.
--
--   * Rolling back to an earlier configuration REPRODUCES that configuration's
--     digest, because the digest is over the content and not over the row.
--     Two windows that were genuinely judged the same way compare equal, which
--     is the question the column exists to answer. A rollback is still a new
--     history row with its own `activated_at`, so the timeline is not lost.
--
-- jsonb's text form is canonical — keys sorted, whitespace normalised — so the
-- digest is stable across two objects that differ only in how they were typed.

create or replace function public.ai_config_digest(
  p_parts jsonb,
  p_model text,
  p_max_output_tokens int
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(
    md5(
      coalesce(p_parts, '{}'::jsonb)::text
      || '|' || coalesce(p_model, '')
      || '|' || coalesce(p_max_output_tokens::text, '')
    ), 12);
$$;

revoke all on function public.ai_config_digest(jsonb, text, int) from public, anon;
grant execute on function public.ai_config_digest(jsonb, text, int) to authenticated;

-- ============================================================
-- 7. Activating, rolling back, and going back to the code
-- ============================================================
--
-- All three are `security definer`, because staff hold no UPDATE grant on
-- `ai_service_versions` — which is the whole reason the test gate is
-- enforceable. `security definer` bypasses RLS, so each one checks
-- `public.is_staff()` in its own body. If the check is not here, it is not
-- made anywhere.

create or replace function public.activate_ai_version(p_version_id uuid)
returns public.ai_service_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_service_versions%rowtype;
begin
  if not public.is_staff() then
    raise exception 'Club staff only' using errcode = '42501';
  end if;

  select * into v_row from public.ai_service_versions where id = p_version_id for update;
  if not found then
    raise exception 'No such version' using errcode = 'P0002';
  end if;

  -- ⚠ THE GATE. Several of these services use strict json_schema structured
  -- outputs, where a prompt that contradicts the schema breaks every call
  -- silently. An untested prompt is not allowed to become the live one, and a
  -- prompt whose test failed certainly is not.
  if v_row.test_status <> 'passed' then
    raise exception
      'Version % of % has not passed a test run (%). Run the test before activating.',
      v_row.version, v_row.service_slug, v_row.test_status
      using errcode = '23514';
  end if;

  -- A test run against a different model than the one being saved proves
  -- nothing about the one being saved. This cannot normally happen — the panel
  -- tests the row it is about to activate — but "cannot normally happen" is
  -- not a property, and the cost of checking is one comparison.
  if v_row.test_model is distinct from v_row.model then
    raise exception
      'Version % of % was tested against % but stores %. Re-run the test.',
      v_row.version, v_row.service_slug, coalesce(v_row.test_model, '(nothing)'), v_row.model
      using errcode = '23514';
  end if;

  if v_row.is_active then
    return v_row;
  end if;

  update public.ai_service_versions
     set is_active = false
   where service_slug = v_row.service_slug and is_active;

  update public.ai_service_versions
     set is_active = true,
         activated_at = now(),
         activated_by = auth.uid()
   where id = p_version_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.activate_ai_version(uuid) from public, anon;
grant execute on function public.activate_ai_version(uuid) to authenticated;

-- One click, and it is a new row rather than a resurrection of an old one.
--
-- The old row keeps its own place in the timeline — "this was live from the
-- 3rd to the 14th" stays true — and the new row records what it came from. The
-- digest recomputes to the same value the source had, so the judge correctly
-- reports the configuration as the same one it was before the bad edit, which
-- is what makes score comparisons across a rollback honest.
--
-- The source must already have passed its test, so a rollback needs no fresh
-- OpenAI call. That is deliberate: the moment somebody most needs to roll back
-- is the moment the model call is most likely to be the thing that is broken.
create or replace function public.rollback_ai_version(p_source_version_id uuid)
returns public.ai_service_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_src public.ai_service_versions%rowtype;
  v_new public.ai_service_versions%rowtype;
begin
  if not public.is_staff() then
    raise exception 'Club staff only' using errcode = '42501';
  end if;

  select * into v_src from public.ai_service_versions where id = p_source_version_id;
  if not found then
    raise exception 'No such version' using errcode = 'P0002';
  end if;
  if v_src.test_status <> 'passed' then
    raise exception 'Version % of % never passed a test run — there is nothing safe to roll back to.',
      v_src.version, v_src.service_slug using errcode = '23514';
  end if;

  insert into public.ai_service_versions
    (service_slug, parts, model, max_output_tokens, note, created_by,
     rolled_back_from, test_status, tested_at, test_model, test_detail)
  values
    (v_src.service_slug, v_src.parts, v_src.model, v_src.max_output_tokens,
     'Rolled back to v' || v_src.version ||
       case when coalesce(v_src.note, '') = '' then '' else ' (' || v_src.note || ')' end,
     auth.uid(),
     v_src.version, v_src.test_status, v_src.tested_at, v_src.test_model, v_src.test_detail)
  returning * into v_new;

  return public.activate_ai_version(v_new.id);
end;
$$;

revoke all on function public.rollback_ai_version(uuid) from public, anon;
grant execute on function public.rollback_ai_version(uuid) to authenticated;

-- The escape hatch of last resort, and the reason a bad edit can never be
-- unrecoverable: put a service back on the prompt in its own source file.
-- Nothing is deleted — the history stays — the service simply has no active
-- version, and `ai-config.ts` falls all the way back to the code defaults.
create or replace function public.reset_ai_service_to_code(p_slug text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'Club staff only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ai_services where slug = p_slug) then
    raise exception 'Unknown AI service %', p_slug using errcode = 'P0002';
  end if;

  update public.ai_service_versions
     set is_active = false
   where service_slug = p_slug and is_active;
end;
$$;

revoke all on function public.reset_ai_service_to_code(text) from public, anon;
grant execute on function public.reset_ai_service_to_code(text) to authenticated;

-- ============================================================
-- 8. What the functions read
-- ============================================================
--
-- One row per service that has an active version. Services running on their
-- code defaults are ABSENT from this view rather than present with nulls, so
-- `ai-config.ts` gets a clean "nothing stored" answer from `maybeSingle()`
-- instead of having to tell a null column from a null row.
--
-- `security_invoker = off` and no client grant at all: the only reader is an
-- Edge Function holding the service role. Staff read `ai_service_overview`
-- below, which is the same information plus the parts of it a person needs.

drop view if exists public.ai_active_config;
create view public.ai_active_config
with (security_invoker = off) as
select
  v.service_slug as slug,
  v.model,
  v.max_output_tokens,
  v.parts,
  v.version,
  v.config_digest
from public.ai_service_versions v
where v.is_active;

-- ⚠ Load-bearing, not tidiness: Supabase grants ALL on a new view to anon and
-- authenticated. Without this the prompts and the model names are readable by
-- anybody with the publishable key. Nothing is granted back — the service role
-- keeps its own default grant and is the only reader.
revoke all on public.ai_active_config from anon, authenticated;

-- ---- What the panel reads ---------------------------------------------
--
-- ⚠ `security_invoker = off`, so this reads its base tables with the owner's
-- rights and RLS does not apply to it. The `public.is_staff()` in the WHERE
-- clause IS the access control for this view — the same arrangement 0023's
-- `member_directory`, 0027's `prospect_directory` and 0029's legacy views use.
-- Removing it does not make the view slightly more permissive; it makes it
-- world-readable.

drop view if exists public.ai_service_overview;
create view public.ai_service_overview
with (security_invoker = off) as
select
  s.slug,
  s.label,
  s.blurb,
  s.kind,
  s.endpoint,
  s.model_env,
  s.code_default_model,
  s.parts_shape,
  s.recommended_max_output_tokens,
  s.max_output_tokens_editable,
  s.ceiling_note,
  s.bumps_judge_version,
  s.sort_order,

  -- Which Edge Functions this configuration is wired into. The panel shows it
  -- before the edit box, because "you are editing both avatar functions" is
  -- something to know before typing, not after saving.
  (
    select coalesce(jsonb_agg(jsonb_build_object(
             'function_name', f.function_name,
             'usage_note', f.usage_note
           ) order by f.function_name), '[]'::jsonb)
      from public.ai_service_functions f
     where f.service_slug = s.slug
  ) as used_by,

  -- Null everywhere when the service is running on its code defaults, which is
  -- the state this platform starts in and returns to.
  v.id as active_version_id,
  v.version as active_version,
  v.model as active_model,
  v.max_output_tokens as active_max_output_tokens,
  v.parts as active_parts,
  v.config_digest as active_digest,
  v.note as active_note,
  v.activated_at,
  v.rolled_back_from,
  v.tested_at,
  p.full_name as activated_by_name,

  -- The effective model, so the panel never has to say "gpt-5 or whatever the
  -- secret is" — it says which, and whether that came from here or from the
  -- Edge Function secret.
  coalesce(v.model, s.code_default_model) as effective_model,
  (v.id is not null) as is_overridden,

  (select count(*) from public.ai_service_versions h where h.service_slug = s.slug) as version_count
from public.ai_services s
left join public.ai_service_versions v
       on v.service_slug = s.slug and v.is_active
left join public.profiles p
       on p.user_id = v.activated_by
where public.is_staff();

revoke all on public.ai_service_overview from anon, authenticated;
grant select on public.ai_service_overview to authenticated;

-- ============================================================
-- 9. Access
-- ============================================================
--
-- Every object below is revoked first. Supabase's default privileges hand ALL
-- on new tables to anon and authenticated, so on a table holding "which model
-- are we paying for and what does the judge's prompt say" the revoke is the
-- control and the grant is the exception to it.

alter table public.ai_services enable row level security;
revoke all on public.ai_services from anon, authenticated;
grant select on public.ai_services to authenticated;

drop policy if exists "ai services: staff read" on public.ai_services;
create policy "ai services: staff read" on public.ai_services
  for select using (public.is_staff());

-- No write policy of any kind. The catalogue of services is a fact about the
-- code — which functions exist, what endpoint they call, what parts they have
-- — and it changes when the code changes, which means in a migration. A panel
-- that could invent a ninth service would be a panel that could invent a
-- service nothing reads.

alter table public.ai_service_functions enable row level security;
revoke all on public.ai_service_functions from anon, authenticated;
grant select on public.ai_service_functions to authenticated;

drop policy if exists "ai service functions: staff read" on public.ai_service_functions;
create policy "ai service functions: staff read" on public.ai_service_functions
  for select using (public.is_staff());

alter table public.ai_models enable row level security;
revoke all on public.ai_models from anon, authenticated;
grant select on public.ai_models to authenticated;

drop policy if exists "ai models: staff read" on public.ai_models;
create policy "ai models: staff read" on public.ai_models
  for select using (public.is_staff());

-- Written only by `ai-admin` as the service role, from OpenAI's own listing.
-- No client role may insert or update: a row here is what §5 checks a model
-- against, so a member — or a staff member — who could write one could
-- authorise any string as an image model.

alter table public.ai_service_versions enable row level security;
revoke all on public.ai_service_versions from anon, authenticated;

drop policy if exists "ai versions: staff read" on public.ai_service_versions;
create policy "ai versions: staff read" on public.ai_service_versions
  for select using (public.is_staff());

drop policy if exists "ai versions: staff draft" on public.ai_service_versions;
create policy "ai versions: staff draft" on public.ai_service_versions
  for insert with check (
    public.is_staff()
    -- Belt and braces with the column grant below, and with the trigger. The
    -- grant is the structural control; these hold if a later migration widens
    -- the grant without reading this comment. 0029 makes the same argument
    -- about `promptarena_submissions`.
    and created_by = auth.uid()
    and not is_active
    and test_status = 'untested'
  );

-- ⚠ THE ACCESS DECISION OF THIS FILE, stated once, in full.
--
-- `authenticated` (and therefore staff, who are authenticated) gets SELECT and
-- INSERT on six named columns. It does not get UPDATE. It does not get DELETE.
-- Neither omission is an oversight:
--
--   * **No UPDATE, so staff cannot mark their own prompt as tested.**
--     `test_status`, `tested_at`, `test_model` and `test_detail` are written
--     only by `ai-admin` running as the service role, after it has actually
--     made the call. `activate_ai_version` refuses anything not 'passed'. If
--     staff held UPDATE — even column-level on test_status — the gate would be
--     a suggestion. `is_active`, `activated_at` and `activated_by` are outside
--     the grant for the same reason: activation goes through the security
--     definer function or it does not happen.
--     ⚠ A column-level revoke cannot carve an exception out of a table-level
--     grant (0002 learned this the hard way, and 0029 restates it). If UPDATE
--     is ever needed here it must be granted column by column, never granted
--     table-wide and then narrowed.
--
--   * **No DELETE, because the history is the recovery mechanism.** A one-click
--     rollback is only worth anything if the thing being rolled back to is
--     still there. Somebody who could delete the version they regret could
--     delete the version they need. Nothing here grows without bound — eight
--     services and a handful of edits a year.
--
--   * `version`, `config_digest` and `created_by` are outside the grant because
--     they are derived. §5 assigns them. A caller who could set `config_digest`
--     could make two different judge configurations report as the same one.
grant select on public.ai_service_versions to authenticated;
grant insert (service_slug, parts, model, max_output_tokens, note)
  on public.ai_service_versions to authenticated;

-- ============================================================
-- 10. Verification — run these, do not assume
-- ============================================================
--
-- ---- The revokes actually took ----------------------------------------
--
-- Expect ZERO rows. Anything here means the prompts, the model names or the
-- change history are readable with the publishable key:
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('ai_services','ai_service_functions','ai_models',
--                         'ai_service_versions','ai_active_config','ai_service_overview')
--      and grantee = 'anon';
--
-- Expect exactly this and nothing else — SELECT on the four readable objects,
-- and INSERT on `ai_service_versions`:
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name like 'ai\_%'
--      and grantee = 'authenticated'
--    order by table_name, privilege_type;
--   -- expect NO UPDATE and NO DELETE on ai_service_versions, and no grant of
--   -- any kind on ai_active_config
--
-- The INSERT grant names five columns and not the derived or gating ones
-- (expect exactly: max_output_tokens, model, note, parts, service_slug):
--   select column_name from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'ai_service_versions'
--      and grantee = 'authenticated' and privilege_type = 'INSERT'
--    order by column_name;
--
-- ---- The staff-only views really are ----------------------------------
--
-- Both views read with the owner's rights, so the predicate has to be inside.
-- Expect `is_staff` to appear in the overview's definition:
--   select definition from pg_views
--    where schemaname = 'public' and viewname = 'ai_service_overview';
--
-- And prove it rather than reading it. Signed in as a MEMBER (not staff):
--   select count(*) from public.ai_service_overview;   -- expect 0
--   select count(*) from public.ai_services;           -- expect 0 (policy)
--   insert into public.ai_service_versions (service_slug, parts, model)
--     values ('promptarena-judge', '{}'::jsonb, 'gpt-5');  -- expect: denied
--
-- ---- A text model cannot be saved for an image service ----------------
--
-- The one rule that had to be impossible rather than discouraged. Expect an
-- exception naming both kinds (run as staff, after refreshing the model list):
--   insert into public.ai_service_versions (service_slug, parts, model)
--     values ('avatar-art', '{}'::jsonb, 'gpt-5');
--   -- expect: ERROR ... gpt-5 is a text model; avatar-art is an image service
--
-- And the mirror, so "it always errors" cannot pass this check — the same
-- insert with an image model must succeed:
--   insert into public.ai_service_versions (service_slug, parts, model)
--     values ('avatar-art', '{}'::jsonb, 'gpt-image-1') returning version, config_digest;
--
-- A model that is not in the list at all is refused, so a typo cannot go live:
--   insert into public.ai_service_versions (service_slug, parts, model)
--     values ('write-member-intro', '{}'::jsonb, 'gtp-5');   -- note the typo
--   -- expect: ERROR ... is not in the model list
--
-- An unknown part key is refused rather than stored inert:
--   insert into public.ai_service_versions (service_slug, parts, model)
--     values ('write-member-intro', '{"sytem":"..."}'::jsonb, 'gpt-5');
--   -- expect: ERROR ... has no editable part called "sytem"
--
-- ---- Untested prompts cannot go live ----------------------------------
--
-- The gate, end to end. Insert a draft as staff, then try to activate it:
--   select public.activate_ai_version('<the new id>');
--   -- expect: ERROR ... has not passed a test run (untested)
--
-- Expect ZERO rows — an active version that never passed a test would mean the
-- gate has a hole:
--   select service_slug, version, test_status from public.ai_service_versions
--    where is_active and test_status <> 'passed';
--
-- Expect ZERO rows — an active version tested against a different model:
--   select service_slug, version, model, test_model
--     from public.ai_service_versions
--    where is_active and test_model is distinct from model;
--
-- At most one active version per service (expect zero rows):
--   select service_slug, count(*) from public.ai_service_versions
--    where is_active group by service_slug having count(*) > 1;
--
-- ---- The two avatar functions still share one house style -------------
--
-- ⚠ The property `_shared/avatar-art.ts` exists to hold. Expect exactly two
-- rows, both with service_slug = 'avatar-art':
--   select function_name, service_slug from public.ai_service_functions
--    where function_name in ('generate-avatar','refresh-avatars');
--
-- Expect ZERO rows — an avatar function pointing at a service of its own would
-- mean the house style has been split in two:
--   select f.function_name, f.service_slug from public.ai_service_functions f
--    where f.function_name in ('generate-avatar','refresh-avatars')
--      and f.service_slug <> 'avatar-art';
--
-- And there is only ever one row of avatar prompt text to be out of step with
-- itself (expect one row, or none before the first edit):
--   select count(*) from public.ai_service_versions
--    where service_slug = 'avatar-art' and is_active;
--
-- ---- The judge's version really does move -----------------------------
--
-- ⚠ The check that matters most, because the failure is silent. Take the
-- judge's current digest, activate a changed prompt, and confirm it moved:
--   select active_digest from public.ai_service_overview where slug = 'promptarena-judge';
--   -- ... activate a version with a changed prompt ...
--   select active_digest from public.ai_service_overview where slug = 'promptarena-judge';
--   -- expect a DIFFERENT value
--
-- Then judge one submission and confirm the string reached the row. It must be
-- the code constant, a '+', and that digest:
--   select judge_version, judge_model from public.promptarena_submissions
--    order by judged_at desc nulls last limit 5;
--
-- Expect ZERO rows — a submission judged after an override was activated that
-- still carries a bare code version means the bump did not reach the judge:
--   select id, judged_at, judge_version from public.promptarena_submissions
--    where judged_at > (select activated_at from public.ai_service_overview
--                        where slug = 'promptarena-judge')
--      and judge_version not like '%+%';
--
-- The digest is over content, so a rollback reproduces it (expect the two
-- digests to be EQUAL, and the two version numbers to differ):
--   select version, rolled_back_from, config_digest
--     from public.ai_service_versions
--    where service_slug = 'promptarena-judge' order by version;
--
-- ---- The code default is still the floor ------------------------------
--
-- ⚠ The property everything else depends on. With no active version, the view
-- the functions read must be EMPTY for that service, not present with nulls:
--   select public.reset_ai_service_to_code('write-member-intro');
--   select count(*) from public.ai_active_config where slug = 'write-member-intro';
--   -- expect 0
--
-- And end to end, which is the only version of this check that is worth
-- anything: with no active version, trigger a member introduction and confirm
-- it is still written. The Edge Function log should carry no `ai-config`
-- warning, and the card should appear as it always did.
--
-- Then the harsher version of the same test — break the database and confirm
-- nothing stops. Revoke the service role's read on the view, run any service,
-- and confirm it still answers on its code defaults with one warning line:
--   -- (in a scratch environment only)
--   revoke select on public.ai_active_config from service_role;
--   -- ... run parse-profile-document ...
--   -- expect: it works, and the log says "using code defaults"
--   grant select on public.ai_active_config to service_role;
--
-- ---- The model list is live, not remembered ---------------------------
--
-- Expect rows only after somebody has refreshed the list from the panel, and
-- expect the refresh timestamp to be recent rather than the migration's:
--   select kind, count(*), max(refreshed_at) from public.ai_models
--    where available group by kind order by kind;
--
-- Expect ZERO rows — a model this migration invented would mean somebody
-- hardcoded a list after all:
--   select id from public.ai_models where refreshed_at = first_seen_at
--     and first_seen_at < now() - interval '1 year';
--
-- ---- `profiles` was not touched ---------------------------------------
--
-- This migration adds no column to `profiles` and grants no UPDATE on it. The
-- allowlist must be exactly what 0029 left (expect the 0002/0005/0017/0019/
-- 0029 columns and nothing new):
--   select column_name from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and grantee = 'authenticated' and privilege_type = 'UPDATE'
--    order by column_name;
--
-- Expect ZERO rows — the table-wide UPDATE grant must still be revoked, or the
-- column list above is decorative:
--   select privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'profiles'
--      and grantee = 'authenticated' and privilege_type = 'UPDATE';
--
-- ---- The one mirror in this change ------------------------------------
--
-- The panel shows staff the prompt a service uses when nothing is stored. For
-- `avatar-art` that is a real import of `_shared/avatar-art.ts` and cannot
-- drift. For the six text services `ai-admin` holds a copy, and a copy that
-- falls behind shows a stale starting point (it breaks nothing — the functions
-- read their own constants — but somebody would be editing from the wrong
-- text). No SQL can check this; it is a file comparison:
--
--   For each of parse-profile-document, promptarena-judge,
--   promptarena-challenge, write-member-intro, write-contact-email and
--   import-event, compare `SYSTEM_PROMPT` in
--   supabase/functions/<name>/index.ts against the entry keyed by that slug in
--   CODE_DEFAULTS in supabase/functions/ai-admin/index.ts. Also compare
--   `CARD_BRIEF` in import-event against the `import-event-card` entry.
--
-- ⚠ And the half that DOES matter if it drifts: the JSON schemas in
-- `ai-admin`'s PROBES are mirrors of the ones each function sends. A test that
-- validates against a schema the function does not use proves nothing. Compare
-- the `required` arrays — those are what a failing test is actually checking.
--
-- ---- `build-prospect-profile` is untouched ----------------------------
--
-- ⚠ Ahmed excluded the profile-matching import by name. Expect ZERO rows — a
-- service row for it would mean it was pulled into this panel:
--   select slug from public.ai_services where slug like '%prospect%';
--   select function_name from public.ai_service_functions
--    where function_name = 'build-prospect-profile';
--
-- And grep the function itself: `supabase/functions/build-prospect-profile/`
-- must contain no reference to `ai-config`, `ai_active_config` or `loadAiConfig`.
