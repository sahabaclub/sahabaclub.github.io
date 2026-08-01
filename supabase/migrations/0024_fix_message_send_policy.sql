-- Sahaba Club — member messaging has never worked
-- ------------------------------------------------------------
-- 0013's send policy reads:
--
--   with check (
--     auth.uid() = sender_id
--     and exists (select 1 from public.profiles p
--                  where p.user_id = recipient_id
--                    and p.is_discoverable and p.accepts_messages)
--   )
--
-- The intent is right and the mistake is invisible: **that subquery is itself
-- subject to RLS on `profiles`**, evaluated as the sender. The only SELECT
-- policy on profiles is "read own" (0001) plus staff (0003), so a member can
-- see exactly one row — their own. For any recipient other than themselves the
-- EXISTS finds nothing, returns false, and the insert is refused.
--
-- So every member-to-member message ever attempted has been rejected. It
-- surfaces in the UI as "This member isn't accepting messages any more"
-- (lib/connect.js), which reads as the recipient's choice and sends nobody
-- looking at the policy. The recipient's flags were never consulted.
--
-- The fix is a security definer helper: the check has to run with authority
-- the sender does not have, because it is a question *about someone else*.

create or replace function public.can_receive_messages(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.profiles
    where user_id = p_user_id
      and is_discoverable
      and accepts_messages
  );
$fn$;

comment on function public.can_receive_messages(uuid) is
  'Used by the member_messages insert policy. security definer because the '
  'sender cannot SELECT the recipient''s profile row — RLS restricts profiles '
  'to your own. Returns only a boolean that member_directory already exposes.';

revoke all on function public.can_receive_messages(uuid) from public, anon;
grant execute on function public.can_receive_messages(uuid) to authenticated;

-- Same rule as before, now actually enforceable.
drop policy if exists "messages: send if allowed" on public.member_messages;
create policy "messages: send if allowed" on public.member_messages
  for insert with check (
    auth.uid() = sender_id
    and public.can_receive_messages(recipient_id)
  );

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The helper answers for somebody who is not you (expect true for a
-- discoverable member who accepts messages):
--   select public.can_receive_messages('<their user id>');
--
-- And the honest end-to-end check, which is the one that matters — sign in as
-- one member and insert to another:
--   insert into public.member_messages (sender_id, recipient_id, body)
--   values (auth.uid(), '<their user id>', 'test');
--   -- expect 1 row, not a row-level security violation
--
-- Someone who has switched messages off must still be protected:
--   update public.profiles set accepts_messages = false where user_id = '<id>';
--   select public.can_receive_messages('<id>');   -- expect false
