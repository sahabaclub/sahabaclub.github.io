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
// image  — the event's own artwork, taken from its official site.
// fit    — "cover" for photos and wide key visuals, "contain" for
//          logos, which would otherwise be cropped or blurred.
// scale  — a size figure worth shouting about, shown as a chip.
// If an image ever 404s the card falls back to the event's initials
// on its accent gradient, so a card is never left with a blank panel.
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
    image: "https://aieverythingabudhabi.com/contents/Theme-26/images/AiEverythinglogo12-black.png",
    fit: "contain",
    link: "https://aieverythingabudhabi.com/home",
    accent: "violet"
  },
  {
    name: "World AI Technology Expo",
    dateLabel: "7 – 8 Oct 2026",
    sortDate: "2026-10-07",
    venue: "Mövenpick Grand Al Bustan",
    city: "Dubai, UAE",
    note: "Robotics, intelligent automation and applied AI across industries.",
    scale: "Trade fair + conference",
    image: "https://worldaiexpo.io/assets/images/cover/home-hero.jpg",
    fit: "cover",
    link: "https://worldaiexpo.io/",
    accent: "cyan"
  },
  {
    name: "Dubai AI Festival",
    dateLabel: "26 – 27 Oct 2026",
    sortDate: "2026-10-26",
    venue: "Dubai World Trade Centre",
    city: "Dubai, UAE",
    note: "Hosted by Dubai Future Foundation with DIFC — now at a bigger venue.",
    scale: "150+ sessions · 120+ countries",
    image: "https://dubaiaifestival.com/wp-content/uploads/2025/02/daif-25-featured-image.jpg",
    fit: "contain",
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
    image: "https://www.globalaishow.com/wp-content/uploads/2026/07/global-ai-show-abu-dhabi-og.webp",
    fit: "contain",
    link: "https://www.globalaishow.com/abu-dhabi/",
    accent: "violet"
  },
  {
    name: "GITEX GLOBAL",
    dateLabel: "7 – 11 Dec 2026",
    sortDate: "2026-12-07",
    venue: "Dubai Exhibition Centre, Expo City",
    city: "Dubai, UAE",
    note: "The world's largest tech expo, with a dedicated AI & DeepTech track.",
    scale: "200,000+ attendees · 180 countries",
    image: "https://www.gitex.com/images/GITEX_GLOBAL_2026_logo_lockup_1-0211.png",
    fit: "contain",
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
    image: "https://framerusercontent.com/assets/uV5FgoVHmPT6v1sDlZPYI57fHM.png",
    fit: "cover",
    link: "https://machinescanthink.ai/",
    accent: "gold"
  }
];
