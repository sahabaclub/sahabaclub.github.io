# EduHackAI seed — where every figure came from

`eduhackai-seed.sql` is a harvest of the four completed EduHackAI rounds out of
SharePoint. It is a public record of real people's work, so this file records
exactly which source each field came from and what could not be found. If a
column is NULL in the seed, the answer is here.

Harvested 2026-07-31. Read-only: nothing in SharePoint or Entra was modified.

---

## The sources

The four SitePages named in the brief turned out **not** to contain team tables.
They are class landing pages. The real per-round data lives in two SharePoint
**Lists** on each site, `Teams` and `Members`, read through the site's read-only
REST API (`/_api/web/lists/getbytitle('Teams')/items`).

| Round | Site | Page (`source_url`) | Teams list | Members list |
|---|---|---|---|---|
| 1 | `/sites/EduHackAI` | `SitePages/TrainingHome.aspx` | 12 rows | 44 rows |
| 2 | `/sites/EduHackAI-2401` | `SitePages/ClassHome.aspx` | 16 rows | 50 rows |
| 3 | `/sites/EduHackAI_3` | `SitePages/ClassHome.aspx` | 12 rows | 37 rows |
| 4 | `/sites/EduHackAI_4` | `SitePages/ClassHome.aspx` | 10 rows | 22 rows |

Two further sources were used, both named below where they apply:

- **`Winners_Of_EduHackAI.xlsx`** —
  `/sites/HackathonOperations/Shared Documents/EduHackAI-2/`. The only document
  in the tenant that states placings. Covers rounds 1 and 2 only.
- **The organiser's Outlook calendar** — kickoff and Demo Day events, used for
  round dates. Each date below names the event it came from.

Loaded: **4 rounds, 43 teams, 150 participants.**

---

## Round by round

### Round 1 — `eduhackai-1`

**The page is a stock Microsoft template.** `TrainingHome.aspx` was never edited:
it still reads *"Hi, my name is Megan Bowen… [Sample content]"*. So round 1
contributes **no description, no tagline, no cover image and no coach list**.
`source_url` still points at it because that is where the brief says the round
lives, but do not expect to see anything there.

- `starts_on` **2025-05-24** — calendar event *"EduHackAI Kick-off - Lets make
  magic with technology"*. Independently corroborated: every team in the `Teams`
  list carries `RegistrationDate` = 2025-05-24.
- `ends_on` **2025-06-28** — calendar events *"EduHackAI-1 Live & Online Demo
  'AI Builders Arena'"* and *"EduHackAI-1 Winner Announcement!"*, both that day.
- `mode` **online** — the only round with an explicit format statement:
  `EduHackAI_Knowledge_Hub.docx` says *"Format: Online & Global"* for the
  May 24 – June 2 2025 event.
- `location`, `partner`, `cover_image_url` — **NULL, not found.**

**Ambiguity worth flagging:** the marketing plan describes round 1 as a 10-day
event ending 2 June, but Demo Day and the winner announcement did not happen
until 28 June. `ends_on` is set to the day the round was actually judged.

8 teams loaded. 4 rows were dropped as administrative or test artefacts, all of
them created by staff and holding no participants: `EduHackAI` (the organiser's
own private row, described as the EduHackAI app), `Esraa Team`, `Test`, `Test 2`.
2 member rows were dropped for the same reason: `EduHackTest@sahabaclub.com`
and `wondertest1@sahabaclub.com` (list name "Esraa Test Account").

**Winners** (from `Winners_Of_EduHackAI.xlsx`, column headed "Position"):
1. Innovation Geeks · 2. Finova · 3. ExamAi

The winners file also names the individual members of each placing team, and
those names match the `Members` list team assignments **exactly** — 4 people for
Innovation Geeks, 3 each for Finova and ExamAi. That is a genuine cross-check,
not a coincidence, and it is the reason the placings can be trusted.

`is_mentor` is **false for every round-1 participant**. Gangothri Rajaram and
Ahmed Badawy appear in round 1's `Members` list and coached later rounds, but
round 1 has no coach list of any kind, so flagging them would be a guess.

### Round 2 — `eduhackai-2`

- `description` — the page's text web part, verbatim.
- `starts_on` **2025-07-12** — calendar event *"EduHackAI-2 Kick-off"*.
- `ends_on` **2025-08-02** — calendar event *"EduHackAI-2.0 Demo Day - AI
  Builders Arena"*, whose body confirms *"Saturday, August 2, 2025, 6:00 PM –
  9:00 PM"*.
- `location` **CodersHQ - Emirates Towers** — the literal `location` field of
  that Demo Day event. This is the Demo Day venue, **not** where the 10-day
  hackathon ran.
- `cover_image_url` — the hero image web part at the top of the page. Behind
  tenant auth; it will not render for anonymous visitors as-is.
- `mode` — **NULL.** The page calls it a *"global hackathon"* and Demo Day was
  in person, which reads like hybrid, but no source says the word. Left NULL
  rather than guessed.
- `partner` — **NULL, not found.**

15 teams. `EduHackAI-2`, the organiser's private admin row, was dropped.

**Winners** (same file, same cross-check against rosters — all three teams'
members match exactly):
1. The AI Geeks (Clever Mart) · 2. Everest · 3. Pioneers

The winners file writes the first-place team as **"The AI Geeks"**; the round's
own `Teams` list calls it **"The AI Geeks (Clever Mart)"**. The list spelling is
used, since that is the round's own record of its team name.

**Mentors:** Ahmed Abdel Razek, Gangothri Rajaram, Ahmed Badawy and Mohamed Mohi
El-Dien — the four people in the page's "Coaches" web part. Round 2's `Members`
list corroborates this independently: those rows literally have `Title` =
"Coach".

### Round 3 — `eduhackai-3`

- `description` — the page's text web part, verbatim (same wording as round 2).
- `starts_on` **2025-08-23** — calendar event *"EduHackAI-3 Kick-off"*.
- `ends_on` **2025-09-26** — calendar event *"EduHackAI-3 Demo Day - Live from
  Cairo"*.
- `location` — **NULL.** The Demo Day subject says "Live from Cairo" but the
  event's own location field says "Microsoft Teams Meeting". Not recorded rather
  than resolved by guesswork.
- `mode`, `partner` — **NULL, not found.**

**Date conflict, unresolved:** `EduHackAI-3.docx` (a marketing brief) says
*"EduHackAI-3.0 starts August 16"*. The kickoff meeting is dated 23 August. The
calendar event is used because it records what happened rather than what was
planned.

11 teams. The `EduHackAI-3` admin row was dropped. **Team "Z" was kept** even
though it looks like a scratch row (one member, score 0, no summary) — it has a
real participant attached (Ahmed Rezk, flagged as its creator), and deleting a
real person's team affiliation is worse than carrying an odd name.

**No winners.** Nothing in SharePoint records placings for round 3. There is a
`Shorlisted Names for EduHackAI-3.xlsx`, but shortlisted is not placed, so it
was not used. Every round-3 team is `is_winner = false`, `rank = NULL` — read
that as *not recorded*, not *did not place*.

**Mentors:** Ahmed Abdel Razek, Gangothri Rajaram, Ahmed Badawy, from the page's
"Coaches" web part.

### Round 4 — `eduhackai-4`

- `name` **EduHackAI-4 (Arabic Edition)**, `tagline` and `description` — all
  from the page's heading and text web part, verbatim.
- `starts_on` **2025-12-06** — calendar event *"Kick Start EduHackAI-4"*.
- `ends_on` — **NULL.** No Demo Day event exists for round 4 in the calendar
  through January 2026. The round is marked `completed` per the brief, but its
  end date is genuinely unrecorded.
- `location`, `mode`, `partner` — **NULL, not found.**

9 teams. The `EduHackAI` admin row and the `EduHackAI4_Test` member row were
dropped.

**No winners.** Same situation as round 3.

**Mentors:** Ahmed Abdel Razek, Ahmed Badawy, Emad Adel, from the page's
"Coaches" web part. Note the web part is titled "Coaches" but gives Emad Adel
the role label "Member" — flagged as a mentor on the strength of the web part's
title, which is a judgement call a human may want to reverse.

---

## Decisions that apply to every round

**`project_title` is NULL for all 43 teams.** The `Teams` lists have exactly one
free-text field about the work, `AboutTeamSolution`, which is loaded into
`project_summary` verbatim. There is no title column. Several summaries do open
with what is obviously the product name ("SkillMatch AI is a platform that…",
"TrackWise Ai…", "Suzy is a study platform…") but splitting a title out of a
sentence would be authoring, not recording.

**`project_url`, `demo_url`, `repo_url`, `image_url` are NULL for all teams.**
No such columns exist in any of the four lists. Teams do have `TeamImage` /
`TeamImage2` thumbnail attachments, but those are internal SharePoint attachment
blobs, not URLs anything outside the tenant can fetch.

**`award` is NULL for all teams.** The winners file's column is headed simply
"Position" and carries no category names. There is no per-round award wording to
preserve, so nothing was invented and nothing was normalised.

**`score` is NULL for all teams — deliberately.** The `Teams` lists do carry
`TeamScoreNow`, `JudgeScoreRaw`, `PublicVoteScoreRaw` and `PublicVoteCount`.
They were **not** loaded for two reasons: the target column is
`numeric(6,2)`, which cannot hold round 1's values (Innovation Geeks scored
23300), and the four score columns mean different things across rounds — rounds
2–4 have `JudgeScoreRaw` = 0 for every team, so a naive load would publish "0"
as a judge's verdict on 34 teams' work. If scores are wanted later, widen the
column and load `TeamScoreNow` only.

**Also NOT loaded, and available if wanted:** `Teams.Creator` (the mailbox of
whoever created each team) and `Members.IsCreator` (a per-person flag, true for
one member of most teams). This is real "team lead" information but the schema
has no column that honestly holds it — `role_in_team` is the person's own
declared skill role, and overwriting it with "Lead" would destroy data. Rounds
also have a `Team_Score` list (128/138/104/29 rows) of per-task scoring, and
round 1 has a `Verified Evaluators List` (29 rows) which *may* be judges but is
just as likely to be public voters — it was not used, and `is_judge` is
therefore **false for all 150 participants**. No source anywhere names a judge.

**`full_name`** is `First Name` + `Last Name` from the `Members` list. Rounds
2–4 have a junk `Title` column ("1", "2", "Coach", "Repeat"), so it was not used.
Source spellings are preserved even where they look wrong:

- `SENTHIL Maran Gnanasekaran` and `Firas SULEIMAN` keep their source casing.
- `Yousef Raafat` (round 2, Pioneers) is called **"Youssef Elmalatawy"** in the
  winners file, and his own LinkedIn URL says "yousef-el-malatawy". The round's
  own `Members` list spelling is used. Worth a human correcting at source.
- `Sidratul Hayat Khan` (round 1) / `Sidratul Khan` (rounds 2–3) / `Sidratul H`
  (round 4) are the same person, spelled three ways across three lists. Each
  round keeps its own spelling; they link on the shared mailbox regardless.

**`email` vs `ms365_mailbox`.** `email` is the person's own address
(`Personal Email` in the source), falling back to the tenant mailbox where no
personal address was given. `ms365_mailbox` is always the @sahabaclub.com
address. `link_hackathon_history()` matches on either, so a participant links
whichever they sign up with.

**`role_in_team`** is the `Your Role` multi-choice verbatim, including its
comma-joined form ("Frontend (Design),Backend (DB & Automation),AI Services").
It is **self-declared by the participant at registration**, not a role assigned
by organisers — so "AI Coach" appearing there does not make someone a coach, and
it was not used to set `is_mentor`.

**`university_or_company`** is the `CurrentCompany` column. Values that were
obvious placeholder noise (`No`, `None`, `-`, `.`, `test`, `1st`, `first`,
`lower`, `self`) were replaced with NULL. Everything else is verbatim, including
misspellings like "Damita university" and "Facalty of Computer and Data Science".

**Team names were whitespace-trimmed.** Nine had stray leading or trailing
spaces in SharePoint (`'AuraVisor '`, `' Innovate AI'`, `'For you '`…). Trimming
was applied identically to the team rows and to the participant→team links, so
the joins still resolve; a post-load check confirmed 0 orphaned links and 0
duplicate names.

**Participants with no team.** 55 of 150 have `team_id` NULL: 19 in round 1,
14 in round 2, 13 in round 3, 9 in round 4. In every case the source records no
team, or records a team that was one of the dropped admin/test rows. Nobody was
assigned a team by inference.

**One oddity to check by hand.** In round 2, coaches Ahmed Badawy and Mohamed
Mohi El-Dien are linked by the `Members` list to team "Reham", and Gangothri
Rajaram to the admin team. That looks like a data-entry artefact rather than
those three competing on that team. The source's link was kept rather than
silently deleted, but they are flagged `is_mentor = true`, so the roster shows
them as mentors. If it is wrong, fix it in SharePoint and re-run this seed.

---

## Entra cross-check — skipped, and why

The brief allows skipping the tenant user listing if awkward. It was skipped.

It was not needed: **every one of the 150 participants already carries an
@sahabaclub.com mailbox taken directly from the round's own `Members` list**,
which is tenant-backed data maintained by the organisers. An Entra export would
have re-derived the same addresses. The one thing it could have added is
corrected name spellings — the specific cases worth checking are listed above.
The browser was also being driven by another agent during this run, which made
an interactive Entra session unreliable.

`ms365_mailbox` is populated for all 150 rows. No tenant user was created,
modified or deleted.

---

## Checking this work against the source

Open any round's list directly, no admin rights needed beyond normal access:

```
https://lawauedu.sharepoint.com/sites/EduHackAI_3/Lists/Teams
https://lawauedu.sharepoint.com/sites/EduHackAI_3/Lists/Members
```

Swap `EduHackAI_3` for `EduHackAI`, `EduHackAI-2401` or `EduHackAI_4`. Note that
round 1's `Members` list links to teams via a column called `Team`, while rounds
2–4 use `TeamID` — the two are not the same field, which is easy to trip over.

The placings live in `Winners_Of_EduHackAI.xlsx` under
`/sites/HackathonOperations/Shared Documents/EduHackAI-2/`. Its two tables are
positional: the 19 names in the left table line up row-for-row with the 19
position rows in the right table.
