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
// ============================================================

var FEATURED_EVENTS = [
  {
    name: "Ai Everything Abu Dhabi",
    dateLabel: "5 – 7 Oct 2026",
    sortDate: "2026-10-05",
    venue: "ADNEC Centre",
    city: "Abu Dhabi, UAE",
    note: "Summit 5 Oct · Expo 6 – 7 Oct",
    link: "https://aieverythingabudhabi.com/home",
    accent: "violet"
  },
  {
    name: "World AI Technology Expo",
    dateLabel: "7 – 8 Oct 2026",
    sortDate: "2026-10-07",
    venue: "Mövenpick Grand Al Bustan",
    city: "Dubai, UAE",
    note: "Robotics, automation & applied AI",
    link: "https://worldaiexpo.io/",
    accent: "cyan"
  },
  {
    name: "Dubai AI Festival",
    dateLabel: "26 – 27 Oct 2026",
    sortDate: "2026-10-26",
    venue: "Dubai World Trade Centre",
    city: "Dubai, UAE",
    note: "150+ sessions · 120+ countries",
    link: "https://dubaiaifestival.com/",
    accent: "gold"
  },
  {
    name: "Global AI Show",
    dateLabel: "27 – 28 Oct 2026",
    sortDate: "2026-10-27",
    venue: "Space42 Arena",
    city: "Abu Dhabi, UAE",
    note: "5,000+ AI futurists · 100+ speakers",
    link: "https://www.globalaishow.com/abu-dhabi/",
    accent: "violet"
  },
  {
    name: "GITEX GLOBAL",
    dateLabel: "7 – 11 Dec 2026",
    sortDate: "2026-12-07",
    venue: "Dubai Exhibition Centre, Expo City",
    city: "Dubai, UAE",
    note: "AI & DeepTech track · 200,000+ attendees",
    link: "https://www.gitex.com/gitex-global-2026",
    accent: "cyan"
  },
  {
    name: "Machines Can Think",
    dateLabel: "Next edition · dates TBA",
    sortDate: "",
    venue: "Abu Dhabi",
    city: "United Arab Emirates",
    note: "Research-led AI summit by Polynome",
    link: "https://machinescanthink.ai/",
    accent: "gold"
  }
];
