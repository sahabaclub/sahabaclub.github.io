// ============================================================
// Sahaba Club — Upcoming Events
// ------------------------------------------------------------
// This is the ONLY file you need to touch to add or remove an
// event on the Events page. Order doesn't matter — events are
// sorted by date automatically, and anything with a date in the
// past is hidden automatically too.
//
// To add a new event, copy this block and fill in your details,
// then add it to the EVENTS array below (comma-separated):
//
// {
//   title: "Event Title",
//   country: "Country",
//   location: "City / Venue",
//   date: "2026-09-15",       // YYYY-MM-DD
//   time: "6:00 PM GST",      // shown as-is, any format you like
//   price: "Free",            // "Free" or "Paid" (e.g. "Paid — $20")
//   link: "https://example.com/event",
//   image: "https://... or assets/events/photo.jpg",  // optional
//   description: "Optional 1-2 sentence blurb.",       // optional
//   linkLabel: "View Event",  // optional — button text, defaults to "View Event"
// }
// ============================================================

var EVENTS = [
  {
    title: "AI.TV Community Meet-Up",
    country: "UAE",
    location: "Web3 Productions, Dubai",
    date: "2026-07-30",
    time: "6:30 PM – 9:00 PM",
    price: "Free",
    link: "https://www.google.com/maps/search/?api=1&query=Web3%20Productions&query_place_id=ChIJ4SrR5t1tXz4Rrt7TKiVDaf4",
    linkLabel: "Get Directions",
    image: "assets/events/aitv-community-meetup.avif",
    description: "Welcome to the home of AI creatives in the UAE. Hosted by AI.TV in partnership with ByteDance and Curious Refuge, this is your spot to meet, learn, share, and connect with fellow AI filmmakers and creatives. Open to anyone curious about AI filmmaking — all levels welcome.",
  },
  {
    title: "AI Cafe by AIQUAINT ☕",
    country: "UAE",
    location: "Starbucks, Emirates Office Tower, Trade Center, Dubai",
    date: "2026-07-25",
    time: "10:00 AM – 11:00 AM",
    price: "Free",
    link: "https://luma.com/5pzl9z2x",
    linkLabel: "Register on Luma",
    image: "https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=800,height=420/event-social/ct/f44167f2-939c-4ef6-bb36-fc8566935f80.png",
    description: "An intimate, no-slides coffee chat for AI folks — founders, builders, and researchers talking honestly about what's really happening in AI right now. Limited seats, real conversations, zero panels.",
  },
  {
    title: "AI Business, Investment & Professional Meetup",
    country: "UAE",
    location: "JLT, Dubai",
    date: "2026-08-06",
    time: "6:30 PM – 8:30 PM",
    price: "Free",
    link: "https://luma.com/st1efdgi",
    linkLabel: "Register on Luma",
    image: "https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=800,height=420/event-social/is/3446b86b-9c1d-4d65-9720-f7f7ebde72d8.png",
    description: "A high-signal evening for builders, founders, and investors to swap ideas and spark collaborations — plus live AI demos from the DDS AI Challenge and the launch of the DDS Business Circle.",
  },
  {
    title: "Dubai AI Hub — Builder Lab #3: Voice Agents Hackathon",
    country: "UAE",
    location: "Dubai (venue TBA)",
    date: "2026-08-08",
    time: "8:30 AM – 5:30 PM",
    price: "Free",
    link: "https://luma.com/hai59p7q",
    linkLabel: "Register on Luma",
    image: "https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=800,height=420/event-social/9b/58038cb0-2fd5-4b9d-89d9-59425aa40ae7.png",
    description: "A one-day hackathon backed by ElevenLabs, Devin, and context.dev — build a voice-first AI agent that pulls live web data and actually talks back. Teams of five, free credits from every sponsor, real prizes on the line.",
  },
  {
    title: "Crazy Clauders — B2B Networking for Founders & Business Owners",
    country: "UAE",
    location: "Wild Woven, DIFC / Downtown, Dubai",
    date: "2026-08-25",
    time: "6:30 PM – 8:00 PM",
    price: "Free",
    link: "https://luma.com/skn8qvje",
    linkLabel: "Register on Luma",
    image: "https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=800,height=420/event-social/e7/4f227084-096e-435a-89dc-cbd6e63fbb66.png",
    description: "Dubai's first-ever Clauders meetup, for founders and builders shipping with Claude and other AI tools. Show off what you've built, meet fellow Clauders, and grab a drink — on you, as a thanks to the host for the space.",
  },
  {
    title: "Runway — 4th Annual AI Film Festival",
    country: "UAE",
    location: "in5 Media, Dubai",
    date: "2026-09-01",
    time: "6:30 PM – 9:30 PM",
    price: "Free",
    link: "https://luma.com/hpnd614f",
    linkLabel: "Register on Luma",
    image: "https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=800,height=420/event-social/tq/2e7e1c63-55f0-4166-ae3c-755dbd3a0e9d.png",
    description: "A curated screening of the winning films from Runway's AI Film Festival, followed by relaxed networking with filmmakers, creators, and commercial pros. Co-hosted by Yohan Wadia Studio and In5 — an evening of film, tech, and creativity.",
  },
  {
    title: "EduHackAI — 10-Day AI App Hackathon",
    country: "UAE",
    location: "DIFC AI Campus, Dubai",
    date: "2026-09-15",
    time: "6:00 PM GST",
    price: "Free",
    link: "https://sahabaclub.ai/events.html",
  },
];
