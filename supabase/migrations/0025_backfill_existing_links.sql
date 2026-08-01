-- Sahaba Club — link the members who signed up before linking existed
-- ------------------------------------------------------------
-- 0021 wired link_contact_to_user and link_hackathon_history into
-- handle_new_user, which fires on INSERT into auth.users. That covers everyone
-- who signs up from now on and nobody who already had.
--
-- The effect was invisible and wrong in exactly the way that is hard to spot:
-- Ahmed has four EduHackAI rounds on record under his personal email, and his
-- profile showed none of them, because his auth.users row predates the
-- trigger. Every existing member had the same hole.
--
-- Both functions are idempotent — they only touch rows where the link is still
-- null — so this is safe to re-run and safe to leave in the migration history.

do $$
declare
  u record;
  n_contacts int := 0;
  n_hackathon int := 0;
  hit uuid;
  rounds int;
begin
  for u in select id, email from auth.users where email is not null loop
    begin
      hit := public.link_contact_to_user(u.id, u.email);
      if hit is not null then n_contacts := n_contacts + 1; end if;
    exception when others then
      raise warning 'link_contact_to_user failed for %: %', u.id, sqlerrm;
    end;

    if to_regclass('public.hackathon_participants') is not null then
      begin
        rounds := public.link_hackathon_history(u.id, u.email);
        n_hackathon := n_hackathon + coalesce(rounds, 0);
      exception when others then
        raise warning 'link_hackathon_history failed for %: %', u.id, sqlerrm;
      end;
    end if;
  end loop;

  raise notice 'backfill: % contacts linked, % hackathon participations linked',
    n_contacts, n_hackathon;
end;
$$;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- Ahmed has four rounds on record under his personal address; they should now
-- be attached and visible on his profile:
--   select full_name, jsonb_array_length(hackathons) as rounds
--     from public.member_directory;
--
-- Nothing should be linked to the wrong person — every linked row's email must
-- still match the user it points at (expect zero rows):
--   select p.email, u.email
--     from public.hackathon_participants p
--     join auth.users u on u.id = p.user_id
--    where lower(p.email) <> lower(u.email)
--      and lower(coalesce(p.ms365_mailbox,'')) <> lower(u.email);
--
-- Re-running this migration must change nothing the second time — both
-- functions filter on "link is still null".
