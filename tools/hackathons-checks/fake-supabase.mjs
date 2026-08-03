// Stand-in for lib/supabase-client.js, used only by the Node harness.
// The rows below are shaped like migration 0036's post-apply state:
// four dated rounds (all four with placings) plus an announced round 5 with
// every date, the location, the mode AND the description NULL.

export const rows = {
  hackathons: [
    {
      id: "r5", slug: "eduhackai-5", round_number: 5, name: "EduHackAI-5",
      tagline: null, description: null, status: "announced",
      starts_on: null, ends_on: null, location: null, mode: null, partner: null,
    },
    // `location` follows 0036's convention: it is the Demo Day VENUE, always
    // prefixed with the words "Demo Day", and round 2 held two of them in one
    // field separated by " · ". Round 3 is left with no location at all, so
    // "a round that records no Demo Day contributes none" stays exercised.
    {
      id: "r4", slug: "eduhackai-4", round_number: 4, name: "EduHackAI-4",
      tagline: "Fourth round", status: "completed",
      description: "Ten days, one team, one shipped app — this round ran in Arabic.",
      starts_on: "2025-12-06", ends_on: "2025-12-20",
      location: "Demo Day: Cairo, Egypt", mode: "online", partner: null,
    },
    {
      id: "r3", slug: "eduhackai-3", round_number: 3, name: "EduHackAI-3",
      tagline: null, description: "Third round.", status: "completed",
      starts_on: "2025-09-01", ends_on: "2025-09-11",
      location: null, mode: "online", partner: null,
    },
    {
      id: "r2", slug: "eduhackai-2", round_number: 2, name: "EduHackAI-2",
      tagline: null, description: null, status: "completed",
      starts_on: "2025-05-24", ends_on: "2025-06-28",
      location: "Demo Day 1: CodersHQ, Dubai · Demo Day 2: Cairo, Egypt",
      mode: "online", partner: null,
    },
    // Kept rank-less on purpose: the "a round with no recorded placings must
    // render its teams without medals" case has to stay exercised.
    {
      id: "r1", slug: "eduhackai-1", round_number: 1, name: "EduHackAI-1",
      tagline: null, description: null, status: "completed",
      starts_on: "2025-02-01", ends_on: null,
      location: "Demo Day: Mercure Hotel, Dubai", mode: "in-person", partner: null,
    },
  ],
  hackathon_teams: [
    { id: "t41", hackathon_id: "r4", name: "Team Four A", rank: 1, award: null, is_winner: true, is_recruiting: false },
    { id: "t42", hackathon_id: "r4", name: "Team Four B", rank: 2, award: null, is_winner: false, is_recruiting: false },
    { id: "t43", hackathon_id: "r4", name: "Team Four C", rank: 3, award: "Best Use of AI", is_winner: false, is_recruiting: false },
    { id: "t44", hackathon_id: "r4", name: "Team Four D", rank: 4, award: null, is_winner: false, is_recruiting: false },
    { id: "t31", hackathon_id: "r3", name: "Team Three A", rank: 1, award: null, is_winner: true, is_recruiting: false },
    { id: "t32", hackathon_id: "r3", name: "Team Three B", rank: 2, award: null, is_winner: false, is_recruiting: false },
    { id: "t21", hackathon_id: "r2", name: "Team Two A", rank: null, award: null, is_winner: true, is_recruiting: false },
    { id: "t11", hackathon_id: "r1", name: "Team One A", rank: null, award: null, is_winner: false, is_recruiting: false },
    { id: "t12", hackathon_id: "r1", name: "Team One B", rank: null, award: null, is_winner: false, is_recruiting: false },
  ],
  // Deliberately NOT alphabetical: the view supplies the order and the
  // renderer must not re-sort it. Coaches first, lead coach first of those.
  //
  // The coach rows also carry the three cases the programme-wide "Thanks to
  // our coaches" section has to survive:
  //
  //   * one person coaching several rounds — "Ahmed Zoka" is in r4, r3 and r2
  //     and must fold into ONE card naming all three;
  //   * that person spelled differently between rounds — r2 stores him
  //     lower-case, so deduplication cannot be a plain string match;
  //   * a coach recorded under a single name and nothing else — "Solo", which
  //     is the shape two of the real coaches have, and which must render like
  //     everybody else rather than being special-cased.
  hackathon_roster: [
    { hackathon_id: "r4", team_id: null, full_name: "Ahmed Zoka", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r4", team_id: null, full_name: "Aaron Second Coach", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r4", team_id: "t41", full_name: "Zed Builder", is_mentor: false, is_judge: false, role_in_team: "Developer, Designer", profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r4", team_id: "t41", full_name: "Alice Builder", is_mentor: false, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r4", team_id: null, full_name: "No Team Person", is_mentor: false, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r3", team_id: null, full_name: "Ahmed Zoka", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r3", team_id: null, full_name: "Gangothri Example", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r3", team_id: "t31", full_name: "Alice Builder", is_mentor: false, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r2", team_id: null, full_name: "ahmed zoka", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r1", team_id: null, full_name: "Solo", is_mentor: true, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
    { hackathon_id: "r1", team_id: "t11", full_name: "Someone Else", is_mentor: false, is_judge: false, role_in_team: null, profile_user_id: null, avatar_url: null, headline: null },
  ],
};

// Set by the harness before each dialog test.
export let invokeResult = { data: { ok: true, already: false }, error: null };
export function setInvokeResult(next) { invokeResult = next; }
export const invokeCalls = [];

function builder(table) {
  const p = Promise.resolve({ data: rows[table] || [], error: null });
  const b = {
    select() { return b; },
    order() { return b; },
    then(onOk, onErr) { return p.then(onOk, onErr); },
    catch(onErr) { return p.catch(onErr); },
  };
  return b;
}

export const supabase = {
  from(table) { return builder(table); },
  functions: {
    invoke(name, opts) {
      invokeCalls.push({ name, body: opts && opts.body });
      return Promise.resolve(invokeResult);
    },
  },
};
