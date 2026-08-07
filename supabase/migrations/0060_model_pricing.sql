-- 0060 — what each model costs
-- ============================================================
--
-- Ahmed: "I need you to add each model cost, and to be dynamic, so if cost
-- change from OpenAI the cost change in the panel."
--
-- ⚠ THE HONEST VERSION OF "DYNAMIC", because the obvious reading is not
-- achievable and pretending otherwise would put wrong numbers about money on a
-- screen:
--
-- OpenAI publishes NO PRICING ENDPOINT. `/v1/models` — which `ai-admin` already
-- calls on every panel load, and which is why the model list is genuinely live
-- — returns ids, ownership and creation dates. It does not return a price.
-- Google is the same. Prices live on a marketing page written for humans.
--
-- The two ways to make a page show a number that is not in any API:
--
--   scrape the pricing page   — looks automatic, and fails silently. A layout
--                               change turns "$2.50" into null or, far worse,
--                               into a number lifted from the wrong row. A
--                               spend figure that is confidently wrong is worse
--                               than one that is visibly missing.
--   store it, edit it here    — a number somebody set, with the date they set
--                               it visible beside it.
--
-- This is the second. "Dynamic" is delivered where it can be: the rate lives in
-- the database rather than in code, so changing it is a field edit that takes
-- effect immediately across the panel — no deploy, no release. What it cannot
-- do is notice OpenAI changed their price. Nothing can, short of a person
-- reading the page.
--
-- ⚠ NO PRICES ARE SEEDED. Every rate starts null and the panel shows "not set"
-- with a link to the provider's own pricing page. That is deliberate: this file
-- was written against knowledge with a May 2026 cutoff, model pricing moves
-- often, and a plausible-looking wrong rate is the one failure mode that
-- matters here. A blank asks to be filled; a stale number does not.

alter table public.ai_models
  -- Per ONE MILLION tokens, in USD, which is how both OpenAI and Google
  -- publish. numeric, never float: these are money, and 0.15 + 0.30 must not
  -- depend on binary fractions.
  add column if not exists input_per_1m numeric(12, 4),
  add column if not exists output_per_1m numeric(12, 4),

  -- For image models, where per-token is meaningless.
  add column if not exists price_per_image numeric(12, 4),

  -- ⚠ The date is not decoration. It is the only thing that lets a reader tell
  -- a current rate from one nobody has looked at since March. The panel shows
  -- it beside the number.
  add column if not exists price_updated_at timestamptz,
  add column if not exists price_updated_by uuid references auth.users (id) on delete set null,

  -- Where the number came from, in the setter's own words — "openai.com/pricing
  -- 7 Aug" is a useful audit trail and costs one text column.
  add column if not exists price_source text,

  -- Which company's API this is. Everything today is OpenAI, because that is
  -- the only key the project holds; the column exists so adding Gemini is a
  -- row rather than a schema change.
  add column if not exists provider text not null default 'openai'
    check (provider in ('openai', 'google', 'anthropic', 'other'));

comment on column public.ai_models.input_per_1m is
  'USD per 1M input tokens. NULL means nobody has set it — the panel says so '
  'rather than showing 0, because 0 reads as free.';
comment on column public.ai_models.price_updated_at is
  'When the rate was last set by a person. Shown beside the number so a stale '
  'price is visible as stale. There is no pricing API to refresh it from.';

-- Existing rows are all OpenAI; the default handles new ones.
update public.ai_models set provider = 'openai' where provider is null;

-- ============================================================
-- Setting a rate
-- ============================================================
--
-- A function rather than a direct update, for one reason: price_updated_at and
-- price_updated_by must not be settable by the caller. If the panel wrote them
-- they would eventually be written wrongly — a copied row, a retried request —
-- and the date is the whole value of the feature.
--
-- ⚠ Staff, not global_admin. Editing a rate card is bookkeeping, not authority:
-- it changes what a number on a screen says and nothing about what the system
-- does. `has_admin_section('ai')` is the same gate the rest of this panel uses.

create or replace function public.set_model_price(
  p_model text,
  p_input numeric,
  p_output numeric,
  p_per_image numeric,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.has_admin_section('ai') then
    raise exception 'Not allowed';
  end if;
  if not exists (select 1 from public.ai_models where id = p_model) then
    raise exception 'No such model: %', p_model;
  end if;
  -- Negative money is always a typo, and 0 must stay possible: some models
  -- genuinely are free at some tiers.
  if coalesce(p_input, 0) < 0 or coalesce(p_output, 0) < 0 or coalesce(p_per_image, 0) < 0 then
    raise exception 'A price cannot be negative';
  end if;

  update public.ai_models
     set input_per_1m = p_input,
         output_per_1m = p_output,
         price_per_image = p_per_image,
         price_source = nullif(btrim(coalesce(p_source, '')), ''),
         price_updated_at = now(),
         price_updated_by = auth.uid()
   where id = p_model;
end;
$fn$;

revoke execute on function public.set_model_price(text, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.set_model_price(text, numeric, numeric, numeric, text) to authenticated;

-- ============================================================
-- Verify
-- ============================================================
--
--   select id, provider, input_per_1m, output_per_1m, price_updated_at
--     from public.ai_models order by id limit 10;
--   -- expect provider 'openai' everywhere and every price null
--
--   -- as a member session, must raise 'Not allowed':
--   select public.set_model_price('gpt-5', 1, 2, null, 'test');
