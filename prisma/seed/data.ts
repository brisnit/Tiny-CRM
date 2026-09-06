/**
 * The demo dataset. Written as a narrative rather than random noise: three real
 * businesses with clients at different stages, a couple of deals that are
 * visibly stalling, one project quietly slipping, and follow-ups that have been
 * let go. That is what makes the dashboard and Tiny AI worth looking at on
 * first run.
 */

export type SeedContact = {
  key: string;
  first: string;
  last: string;
  title: string;
  company?: string;
  email: string;
  phone?: string;
  linkedin?: string;
  location?: string;
  relationshipType?: string;
  leadSource?: string;
  tags?: string[];
  /** Days since last contact; undefined means never contacted. */
  lastContactDays?: number;
  followUpDays?: number;
  importance?: number;
};

export type SeedCompany = {
  key: string;
  name: string;
  domain?: string;
  industry: string;
  website?: string;
  size?: string;
  location?: string;
  revenueRange?: string;
  type: string;
  leadSource?: string;
  relationshipStatus?: string;
  description?: string;
  tags?: string[];
};

export const WORKSPACES = [
  {
    key: "ai",
    name: "Artifact Intelligence",
    slug: "artifact-intelligence",
    color: "#068C28",
    description: "AI strategy, predictive analytics and applied machine learning for higher education.",
  },
  {
    key: "digital",
    name: "Artifact Digital",
    slug: "artifact-digital",
    color: "#2563EB",
    description: "Websites, brand systems and digital campaigns for mission-driven organizations.",
  },
  {
    key: "dropq",
    name: "DropQ",
    slug: "dropq",
    color: "#7C3AED",
    description: "A software product for queue-free curbside pickup.",
  },
  {
    key: "bizdev",
    name: "Personal Business Development",
    slug: "business-development",
    color: "#EA580C",
    description: "Investors, advisors, partnerships and the long game.",
  },
] as const;

export const TAGS = [
  "Higher Education", "Government", "Investor", "Partner", "Client", "Prospect",
  "Warm Lead", "Strategic", "RFP", "AI", "Education", "San Diego", "Nonprofit",
  "Referral", "Renewal", "Champion", "Decision Maker", "Budget Holder",
];

// --- Companies -------------------------------------------------------------

export const COMPANIES: (SeedCompany & { workspace: string })[] = [
  {
    workspace: "ai", key: "fuller", name: "Fuller Theological Seminary", domain: "fuller.edu",
    industry: "Higher Education", website: "https://www.fuller.edu", size: "201-1000",
    location: "Pasadena, CA", revenueRange: "50M-250M", type: "client", leadSource: "referral",
    relationshipStatus: "active",
    description: "Graduate seminary. Retention and enrollment analytics program under the Provost's office.",
    tags: ["Higher Education", "Client", "AI", "Strategic"],
  },
  {
    workspace: "ai", key: "sjsu", name: "San Jose State University", domain: "sjsu.edu",
    industry: "Higher Education", website: "https://www.sjsu.edu", size: "1000+",
    location: "San Jose, CA", revenueRange: "250M+", type: "prospect", leadSource: "rfp_portal",
    relationshipStatus: "prospect",
    description: "CSU campus. Open solicitation for student success analytics.",
    tags: ["Higher Education", "Government", "RFP", "Prospect"],
  },
  {
    workspace: "ai", key: "jessup", name: "Jessup University", domain: "jessup.edu",
    industry: "Higher Education", website: "https://jessup.edu", size: "201-1000",
    location: "Rocklin, CA", revenueRange: "10M-50M", type: "client", leadSource: "network",
    relationshipStatus: "active",
    description: "Private Christian university. Started with an enrollment audit, expanding into advising.",
    tags: ["Higher Education", "Client", "Education"],
  },
  {
    workspace: "ai", key: "apu", name: "Azusa Pacific University", domain: "apu.edu",
    industry: "Higher Education", website: "https://www.apu.edu", size: "1000+",
    location: "Azusa, CA", revenueRange: "250M+", type: "prospect", leadSource: "event",
    relationshipStatus: "prospect",
    description: "Met the CIO at the CSU data summit. Interested but budget cycle starts in July.",
    tags: ["Higher Education", "Warm Lead"],
  },
  {
    workspace: "ai", key: "biola", name: "Biola University", domain: "biola.edu",
    industry: "Higher Education", website: "https://www.biola.edu", size: "1000+",
    location: "La Mirada, CA", revenueRange: "250M+", type: "prospect", leadSource: "referral",
    relationshipStatus: "prospect",
    description: "Referred by Fuller's provost. Early conversation about a shared analytics consortium.",
    tags: ["Higher Education", "Referral", "Prospect"],
  },
  {
    workspace: "ai", key: "csulb", name: "CSU Long Beach", domain: "csulb.edu",
    industry: "Higher Education", website: "https://www.csulb.edu", size: "1000+",
    location: "Long Beach, CA", revenueRange: "250M+", type: "prospect", leadSource: "rfp_portal",
    relationshipStatus: "prospect",
    description: "Watching their procurement portal for the analytics modernization RFP.",
    tags: ["Higher Education", "Government", "RFP"],
  },
  {
    workspace: "digital", key: "bbop", name: "BBOP Center", domain: "bbopcenter.org",
    industry: "Nonprofit", website: "https://bbopcenter.org", size: "11-50",
    location: "San Diego, CA", revenueRange: "1M-10M", type: "client", leadSource: "referral",
    relationshipStatus: "active",
    description: "Community center for youth programming. Full website rebuild plus donor portal.",
    tags: ["Nonprofit", "Client", "San Diego", "Strategic"],
  },
  {
    workspace: "digital", key: "harbor", name: "Harbor Community Health", domain: "harborchc.org",
    industry: "Healthcare", website: "https://harborchc.org", size: "51-200",
    location: "San Diego, CA", revenueRange: "10M-50M", type: "client", leadSource: "inbound",
    relationshipStatus: "active",
    description: "FQHC network. Ongoing retainer for campaign landing pages and patient comms.",
    tags: ["Client", "San Diego", "Renewal"],
  },
  {
    workspace: "digital", key: "seaside", name: "Seaside Collective", domain: "seasidecollective.com",
    industry: "Hospitality", website: "https://seasidecollective.com", size: "11-50",
    location: "Encinitas, CA", revenueRange: "1M-10M", type: "prospect", leadSource: "referral",
    relationshipStatus: "prospect",
    description: "Restaurant group. Wants a booking-first site refresh before summer.",
    tags: ["Prospect", "San Diego", "Warm Lead"],
  },
  {
    workspace: "digital", key: "meridian", name: "Meridian Housing Trust", domain: "meridianhousing.org",
    industry: "Nonprofit", website: "https://meridianhousing.org", size: "51-200",
    location: "Los Angeles, CA", revenueRange: "10M-50M", type: "prospect", leadSource: "outbound",
    relationshipStatus: "prospect",
    description: "Affordable housing nonprofit. Grant-funded site rebuild, decision by committee.",
    tags: ["Nonprofit", "Prospect"],
  },
  {
    workspace: "dropq", key: "verdegrocers", name: "Verde Grocers", domain: "verdegrocers.com",
    industry: "Retail", website: "https://verdegrocers.com", size: "201-1000",
    location: "Sacramento, CA", revenueRange: "50M-250M", type: "prospect", leadSource: "outbound",
    relationshipStatus: "prospect",
    description: "Regional grocery chain, 34 stores. Pilot candidate for curbside pickup.",
    tags: ["Prospect", "Strategic"],
  },
  {
    workspace: "dropq", key: "fieldnotes", name: "Fieldnotes Coffee", domain: "fieldnotescoffee.com",
    industry: "Food & Beverage", website: "https://fieldnotescoffee.com", size: "51-200",
    location: "Portland, OR", revenueRange: "1M-10M", type: "client", leadSource: "inbound",
    relationshipStatus: "active",
    description: "12-location coffee roaster. First paying DropQ customer, live in 4 stores.",
    tags: ["Client", "Champion"],
  },
  {
    workspace: "dropq", key: "northgate", name: "Northgate Markets", domain: "northgatemarkets.com",
    industry: "Retail", website: "https://northgatemarkets.com", size: "1000+",
    location: "Anaheim, CA", revenueRange: "250M+", type: "prospect", leadSource: "event",
    relationshipStatus: "prospect",
    description: "Grocery chain met at the NGA show. Long procurement cycle.",
    tags: ["Prospect"],
  },
  {
    workspace: "bizdev", key: "cascade", name: "Cascade Seed Partners", domain: "cascadeseed.vc",
    industry: "Venture Capital", website: "https://cascadeseed.vc", size: "11-50",
    location: "Seattle, WA", revenueRange: "50M-250M", type: "investor", leadSource: "network",
    relationshipStatus: "active",
    description: "Pre-seed fund. Warm intro through a portfolio founder. Wants to see DropQ traction.",
    tags: ["Investor", "Strategic"],
  },
  {
    workspace: "bizdev", key: "tidewater", name: "Tidewater Ventures", domain: "tidewater.vc",
    industry: "Venture Capital", website: "https://tidewater.vc", size: "1-10",
    location: "San Diego, CA", revenueRange: "10M-50M", type: "investor", leadSource: "referral",
    relationshipStatus: "prospect",
    description: "Local micro-fund. Met at a founders dinner, asked for the deck.",
    tags: ["Investor", "San Diego"],
  },
  {
    workspace: "bizdev", key: "lattice", name: "Lattice Consulting Group", domain: "latticecg.com",
    industry: "Consulting", website: "https://latticecg.com", size: "51-200",
    location: "Austin, TX", revenueRange: "10M-50M", type: "partner", leadSource: "network",
    relationshipStatus: "active",
    description: "Higher-ed consultancy. Potential reseller for the analytics practice.",
    tags: ["Partner", "Strategic", "Higher Education"],
  },
];

// --- Contacts --------------------------------------------------------------

export const CONTACTS: (SeedContact & { workspace: string })[] = [
  // Fuller
  { workspace: "ai", key: "sarah", first: "Sarah", last: "Whitfield", title: "Director of Institutional Research",
    company: "fuller", email: "sarah.whitfield@fuller.edu", phone: "+1 626 555 0142",
    linkedin: "https://linkedin.com/in/sarahwhitfield", location: "Pasadena, CA",
    relationshipType: "client", leadSource: "referral", tags: ["Champion", "Higher Education", "Client"],
    lastContactDays: 2, followUpDays: 5, importance: 85 },
  { workspace: "ai", key: "provost", first: "Daniel", last: "Okonkwo", title: "Provost",
    company: "fuller", email: "d.okonkwo@fuller.edu", phone: "+1 626 555 0118", location: "Pasadena, CA",
    relationshipType: "client", leadSource: "referral", tags: ["Decision Maker", "Budget Holder"],
    lastContactDays: 16, followUpDays: -3, importance: 92 },
  { workspace: "ai", key: "fullerit", first: "Priya", last: "Raman", title: "Director of IT",
    company: "fuller", email: "p.raman@fuller.edu", location: "Pasadena, CA",
    relationshipType: "client", tags: ["Higher Education"], lastContactDays: 9 },
  // SJSU
  { workspace: "ai", key: "marcus", first: "Marcus", last: "Delgado", title: "AVP, Student Success",
    company: "sjsu", email: "marcus.delgado@sjsu.edu", phone: "+1 408 555 0177", location: "San Jose, CA",
    relationshipType: "prospect", leadSource: "rfp_portal", tags: ["Decision Maker", "Higher Education", "RFP"],
    lastContactDays: 6, followUpDays: 2, importance: 78 },
  { workspace: "ai", key: "sjsuproc", first: "Lena", last: "Hoffman", title: "Procurement Analyst",
    company: "sjsu", email: "lena.hoffman@sjsu.edu", location: "San Jose, CA",
    relationshipType: "prospect", leadSource: "rfp_portal", tags: ["Government"], lastContactDays: 11 },
  // Jessup
  { workspace: "ai", key: "tom", first: "Thomas", last: "Bergstrom", title: "VP of Enrollment",
    company: "jessup", email: "tbergstrom@jessup.edu", phone: "+1 916 555 0193", location: "Rocklin, CA",
    relationshipType: "client", leadSource: "network", tags: ["Client", "Champion", "Budget Holder"],
    lastContactDays: 4, followUpDays: 10, importance: 80 },
  { workspace: "ai", key: "jessupdata", first: "Alicia", last: "Moreno", title: "Data Analyst",
    company: "jessup", email: "amoreno@jessup.edu", location: "Rocklin, CA",
    relationshipType: "client", tags: ["Higher Education"], lastContactDays: 3 },
  // APU / Biola / CSULB
  { workspace: "ai", key: "apucio", first: "Grace", last: "Lim", title: "Chief Information Officer",
    company: "apu", email: "glim@apu.edu", location: "Azusa, CA",
    relationshipType: "prospect", leadSource: "event", tags: ["Warm Lead", "Decision Maker"],
    lastContactDays: 41, followUpDays: -9, importance: 60 },
  { workspace: "ai", key: "biolaprov", first: "Nathan", last: "Reyes", title: "Associate Provost",
    company: "biola", email: "nathan.reyes@biola.edu", location: "La Mirada, CA",
    relationshipType: "prospect", leadSource: "referral", tags: ["Referral", "Prospect"], lastContactDays: 24 },
  { workspace: "ai", key: "csulbproc", first: "Vivian", last: "Cortez", title: "Contracts Manager",
    company: "csulb", email: "v.cortez@csulb.edu", location: "Long Beach, CA",
    relationshipType: "prospect", leadSource: "rfp_portal", tags: ["Government", "RFP"], lastContactDays: 68 },
  { workspace: "ai", key: "advisor1", first: "Rebecca", last: "Ahn", title: "Independent Higher-Ed Advisor",
    email: "rebecca@ahnadvisory.com", location: "Los Angeles, CA",
    relationshipType: "partner", leadSource: "network", tags: ["Partner", "Referral"], lastContactDays: 19 },

  // BBOP / Digital
  { workspace: "digital", key: "james", first: "James", last: "Okafor", title: "Executive Director",
    company: "bbop", email: "james@bbopcenter.org", phone: "+1 619 555 0155", location: "San Diego, CA",
    relationshipType: "client", leadSource: "referral", tags: ["Client", "Decision Maker", "San Diego"],
    lastContactDays: 1, followUpDays: 7, importance: 88 },
  { workspace: "digital", key: "bbopcomms", first: "Renee", last: "Castillo", title: "Communications Manager",
    company: "bbop", email: "renee@bbopcenter.org", location: "San Diego, CA",
    relationshipType: "client", tags: ["Client"], lastContactDays: 2 },
  { workspace: "digital", key: "bbopboard", first: "Walter", last: "Kim", title: "Board Chair",
    company: "bbop", email: "wkim@bbopcenter.org", location: "San Diego, CA",
    relationshipType: "client", tags: ["Decision Maker"], lastContactDays: 27 },
  { workspace: "digital", key: "harbormk", first: "Denise", last: "Frazier", title: "Marketing Director",
    company: "harbor", email: "dfrazier@harborchc.org", phone: "+1 619 555 0121", location: "San Diego, CA",
    relationshipType: "client", leadSource: "inbound", tags: ["Client", "Renewal"],
    lastContactDays: 8, followUpDays: 14, importance: 72 },
  { workspace: "digital", key: "harborops", first: "Andre", last: "Duval", title: "COO",
    company: "harbor", email: "aduval@harborchc.org", location: "San Diego, CA",
    relationshipType: "client", tags: ["Budget Holder"], lastContactDays: 34 },
  { workspace: "digital", key: "seaside1", first: "Mia", last: "Petrov", title: "Owner",
    company: "seaside", email: "mia@seasidecollective.com", phone: "+1 760 555 0188", location: "Encinitas, CA",
    relationshipType: "prospect", leadSource: "referral", tags: ["Warm Lead", "San Diego"],
    lastContactDays: 5, followUpDays: 3 },
  { workspace: "digital", key: "meridian1", first: "Curtis", last: "Bell", title: "Director of Development",
    company: "meridian", email: "cbell@meridianhousing.org", location: "Los Angeles, CA",
    relationshipType: "prospect", leadSource: "outbound", tags: ["Prospect", "Nonprofit"], lastContactDays: 22 },
  { workspace: "digital", key: "freelance1", first: "Oscar", last: "Nunez", title: "Freelance Motion Designer",
    email: "oscar@nunezmotion.com", location: "San Diego, CA",
    relationshipType: "vendor", tags: ["Partner"], lastContactDays: 12 },

  // DropQ
  { workspace: "dropq", key: "fieldnotes1", first: "Hana", last: "Yoshida", title: "Director of Operations",
    company: "fieldnotes", email: "hana@fieldnotescoffee.com", phone: "+1 503 555 0134", location: "Portland, OR",
    relationshipType: "client", leadSource: "inbound", tags: ["Client", "Champion"],
    lastContactDays: 3, followUpDays: 9, importance: 82 },
  { workspace: "dropq", key: "fieldnotes2", first: "Ben", last: "Whitaker", title: "Founder",
    company: "fieldnotes", email: "ben@fieldnotescoffee.com", location: "Portland, OR",
    relationshipType: "client", tags: ["Decision Maker"], lastContactDays: 15 },
  { workspace: "dropq", key: "verde1", first: "Carla", last: "Jimenez", title: "VP of Store Operations",
    company: "verdegrocers", email: "cjimenez@verdegrocers.com", phone: "+1 916 555 0166", location: "Sacramento, CA",
    relationshipType: "prospect", leadSource: "outbound", tags: ["Decision Maker", "Strategic"],
    lastContactDays: 26, followUpDays: -6, importance: 75 },
  { workspace: "dropq", key: "verde2", first: "Roy", last: "Tanaka", title: "IT Director",
    company: "verdegrocers", email: "rtanaka@verdegrocers.com", location: "Sacramento, CA",
    relationshipType: "prospect", tags: ["Prospect"], lastContactDays: 30 },
  { workspace: "dropq", key: "northgate1", first: "Elena", last: "Vasquez", title: "Director of Innovation",
    company: "northgate", email: "evasquez@northgatemarkets.com", location: "Anaheim, CA",
    relationshipType: "prospect", leadSource: "event", tags: ["Prospect"], lastContactDays: 52 },

  // Business development
  { workspace: "bizdev", key: "cascade1", first: "Ian", last: "Brantley", title: "General Partner",
    company: "cascade", email: "ian@cascadeseed.vc", phone: "+1 206 555 0109", location: "Seattle, WA",
    relationshipType: "investor", leadSource: "network", tags: ["Investor", "Strategic"],
    lastContactDays: 7, followUpDays: 4, importance: 90 },
  { workspace: "bizdev", key: "cascade2", first: "Simone", last: "Adeyemi", title: "Principal",
    company: "cascade", email: "simone@cascadeseed.vc", location: "Seattle, WA",
    relationshipType: "investor", tags: ["Investor"], lastContactDays: 13 },
  { workspace: "bizdev", key: "tidewater1", first: "Paul", last: "Marchetti", title: "Managing Partner",
    company: "tidewater", email: "paul@tidewater.vc", location: "San Diego, CA",
    relationshipType: "investor", leadSource: "referral", tags: ["Investor", "San Diego"],
    lastContactDays: 38, followUpDays: -12, importance: 68 },
  { workspace: "bizdev", key: "lattice1", first: "Karen", last: "Sundberg", title: "Managing Director",
    company: "lattice", email: "karen@latticecg.com", phone: "+1 512 555 0147", location: "Austin, TX",
    relationshipType: "partner", leadSource: "network", tags: ["Partner", "Strategic"],
    lastContactDays: 10, followUpDays: 21, importance: 76 },
  { workspace: "bizdev", key: "mentor1", first: "Gregory", last: "Hall", title: "Former CRO, Ellucian",
    email: "greg.hall@outlook.com", location: "Denver, CO",
    relationshipType: "colleague", leadSource: "network", tags: ["Strategic"], lastContactDays: 45 },
  { workspace: "bizdev", key: "cpa", first: "Michelle", last: "Trang", title: "CPA",
    email: "michelle@trangcpa.com", location: "San Diego, CA",
    relationshipType: "vendor", tags: [], lastContactDays: 61 },
];
