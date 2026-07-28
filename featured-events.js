// ============================================================
// Sahaba Club — Featured mega AI events
// ------------------------------------------------------------
// The headline conferences that get their own scrolling banner
// at the top of the events page. Kept separate from EVENTS in
// events-data.js because these are landmarks people plan a year
// around, not week-to-week meetups.
//
// To add one: copy a block, keep the fields, and put it in date
// order. Set dateLabel to whatever reads best on a card; sortDate
// is the machine-readable start date used to drop past editions.
// Use sortDate "" for an edition whose dates aren't announced yet
// — it stays pinned at the end of the strip.
//
// logo  — the event's official logo, hosted in assets/event-logos.
// tile  — "dark" or "light": the panel the logo sits on. Most of
//         these wordmarks are white, so they need a dark tile;
//         the ones drawn in black ink need a light one. Getting
//         this wrong makes the logo invisible, so check both.
// live  — set instead of logo when the logo is rendered in markup
//         rather than loaded as a file (see Machines Can Think,
//         whose wordmark animates through several verbs).
// scale — a size figure worth shouting about, shown as a chip.
// ============================================================

var FEATURED_EVENTS = [
  {
    name: "Ai Everything Abu Dhabi",
    dateLabel: "5 – 7 Oct 2026",
    sortDate: "2026-10-05",
    venue: "ADNEC Centre",
    city: "Abu Dhabi, UAE",
    note: "The world's leading AI show — summit on 5 Oct, expo 6 – 7 Oct.",
    scale: "Global flagship",
    logo: "assets/event-logos/ai-everything.png",
    tile: "dark",
    link: "https://aieverythingabudhabi.com/home",
    accent: "violet"
  },
  {
    name: "Dubai AI Festival",
    dateLabel: "26 – 27 Oct 2026",
    sortDate: "2026-10-26",
    venue: "Dubai World Trade Centre",
    city: "Dubai, UAE",
    note: "Hosted by Dubai Future Foundation with DIFC — now at a bigger venue.",
    scale: "150+ sessions · 120+ countries",
    logo: "assets/event-logos/dubai-ai-festival.svg",
    tile: "dark",
    link: "https://dubaiaifestival.com/",
    accent: "gold"
  },
  {
    name: "Global AI Show",
    dateLabel: "27 – 28 Oct 2026",
    sortDate: "2026-10-27",
    venue: "Space42 Arena",
    city: "Abu Dhabi, UAE",
    note: "Keynotes, panels and exhibitions across healthcare, finance and security.",
    scale: "5,000+ attendees · 100+ speakers",
    logo: "assets/event-logos/global-ai-show.svg",
    tile: "dark",
    link: "https://www.globalaishow.com/abu-dhabi/",
    accent: "violet"
  },
  {
    // Dates and venue confirmed on the organiser's own event-details page.
    // Several third-party event directories still list an October date at
    // the Mövenpick, which is out of date — don't trust those.
    name: "World AI Technology Expo",
    dateLabel: "17 – 18 Nov 2026",
    sortDate: "2026-11-17",
    venue: "Millennium Airport Hotel",
    city: "Dubai, UAE",
    note: "Enterprise AI in practice, plus the Entrepreneur & Investor Summit on 19 Nov.",
    scale: "Three-day programme",
    logo: "assets/event-logos/world-ai-expo.png",
    tile: "light",
    link: "https://worldaiexpo.io/",
    accent: "cyan"
  },
  {
    name: "GITEX GLOBAL",
    dateLabel: "7 – 11 Dec 2026",
    sortDate: "2026-12-07",
    venue: "Dubai Exhibition Centre, Expo City",
    city: "Dubai, UAE",
    note: "The world's largest tech expo, with a dedicated AI & DeepTech track.",
    scale: "200,000+ attendees · 180 countries",
    logo: "assets/event-logos/gitex-global.png",
    tile: "light",
    link: "https://www.gitex.com/gitex-global-2026",
    accent: "cyan"
  },
  {
    name: "Machines Can Think",
    dateLabel: "Next edition · dates TBA",
    sortDate: "",
    venue: "Abu Dhabi",
    city: "United Arab Emirates",
    note: "Research-led summit by Polynome, with MBZUAI — keynotes and workshops.",
    scale: "50+ keynotes · 10+ workshops",
    live: "mct",
    tile: "dark",
    link: "https://machinescanthink.ai/",
    accent: "gold"
  }
];
