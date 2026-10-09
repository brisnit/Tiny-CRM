/**
 * Three documents with realistic text density, for checking document Q&A
 * against a real model.
 *
 * ## Why density matters, and why one document was not enough
 *
 * The first pass at this used a five-page PDF carrying 881 characters in total.
 * `TARGET_CHARS` in the chunker is 2,400, so the whole document collapsed into
 * **two** chunks spanning pages 1–3 and 4–5, and every citation came back as a
 * three-page range for a fact on one page. That made the citations look far
 * coarser than they are in practice and made every score sit in a narrow band,
 * which is exactly the condition under which a tuned threshold looks like it
 * works.
 *
 * So each page below carries roughly 2,200–2,800 characters, which is what a
 * real procurement page holds, and each document is shaped differently: a
 * structured RFP with numbered sections, a prose services agreement with no
 * numbering, and a dense policy document that reuses the same vocabulary on
 * every page. The third exists specifically to produce *misleading keyword
 * matches* — questions whose terms appear all over the document without the
 * answer being in it anywhere.
 *
 * ## These are synthetic fixtures, not customer documents
 *
 * Every page of text below was written for these tests. None of it comes from a
 * real document, and no customer file is read, copied or shipped by anything in
 * this directory. Where a fixture's *name* matches a real upload — the
 * production canary used a file called "IMPORTANT INFORMATION FOR BIDDERS.pdf"
 * — the name was chosen to make the comparison legible and the contents are
 * still invented. An answer that quotes one of these documents demonstrates the
 * flow; it says nothing about the real file.
 *
 * `fact` is the exact string an answer must contain. `page` is where it is, and
 * a citation naming a different page is a failure even if the fact is right —
 * a page number the reader cannot check is worse than none.
 */

export type Expectation = {
  question: string;
  /** What a correct answer must say. */
  fact?: string;
  /**
   * Other wordings that are equally correct.
   *
   * The document says "thirty percent"; an answer saying "30%" is right. The
   * grader is a screen over prose, so it has to accept the forms a correct
   * answer actually takes — otherwise a right answer is reported as a failure
   * and the genuinely wrong ones are lost in the noise.
   */
  alsoAccept?: string[];
  /** The page a citation must name. */
  page?: number;
  kind: "supported" | "unsupported" | "misleading";
  /** Why this case is here, printed with the result. */
  note?: string;
};

export type Corpus = {
  name: string;
  pages: string[][];
  expectations: Expectation[];
};

/** Repeated filler that carries no answer, to reach a realistic page length. */
function filler(topic: string, n: number): string[] {
  const lines = [
    `Each ${topic} provision is severable, and the invalidity or unenforceability of any provision does not affect the validity or enforceability of the remainder of this document or of any other provision.`,
    `The Vendor acknowledges that the City is a public body subject to disclosure law, and that material submitted in response may be releasable notwithstanding any legend to the contrary applied by the Vendor.`,
    `Any notice required under this section is effective on delivery if delivered by hand, on the third day after posting if sent by first class mail, and on transmission if sent by electronic mail to the address most recently notified in writing.`,
    `All ${topic} obligations in this section are additional to, and do not limit, the general obligations set out elsewhere in this document.`,
    `Where a requirement in this section conflicts with a requirement stated elsewhere, the stricter requirement applies unless the City agrees otherwise in writing.`,
    `The Vendor shall maintain records sufficient to demonstrate compliance with each ${topic} requirement and shall make those records available on reasonable notice.`,
    `Nothing in this section relieves the Vendor of any obligation arising under applicable law, and no waiver of any ${topic} requirement is effective unless given in writing.`,
    `The City may request clarification of any ${topic} matter during evaluation, and a failure to respond within the period stated in the request may be treated as non-responsive.`,
    `References to days in this section mean calendar days unless the section expressly states business days.`,
  ];
  return Array.from({ length: n }, (_, i) => lines[i % lines.length]!);
}

const RFP: Corpus = {
  name: "rfp-2027-114.pdf",
  pages: [
    [
      "Request for Proposal RFP-2027-114",
      "Municipal Records Modernisation Programme",
      "Issued by the City of Ashgrove Procurement Office",
      "This Request for Proposal invites qualified vendors to propose a replacement for the City's records management platform, including migration of historical records, staff training and three years of support.",
      "The programme covers the City Clerk's office, the Planning Department and the Office of the City Attorney. Other departments may be added by amendment.",
      ...filler("procurement", 20),
    ],
    [
      "Section 2 - Submission Timetable",
      "Proposals are due on 14 March 2027 at 5:00 PM Pacific Time.",
      "Late submissions will be returned unopened and will not be evaluated.",
      "Written questions must be submitted by 28 February 2027, and the City will publish consolidated answers by 4 March 2027.",
      "A non-mandatory pre-proposal conference will be held on 20 February 2027.",
      ...filler("submission", 20),
    ],
    [
      "Section 3 - Budget and Invoicing",
      "The total contract ceiling is $485,000 over three years.",
      "Year one is capped at $210,000, inclusive of migration and training.",
      "Invoices are paid net 45 days after acceptance of the associated deliverable.",
      "The City will not pay for work performed before the contract is executed.",
      ...filler("budget", 20),
    ],
    [
      "Section 4 - Insurance and Bonding",
      "Vendors must maintain cyber liability insurance of at least $2,000,000 per occurrence.",
      "A performance bond of ten percent of the contract value is required before work begins.",
      "Certificates of insurance are due before the kickoff meeting and annually thereafter.",
      ...filler("insurance", 21),
    ],
    [
      "Section 5 - Evaluation Criteria",
      "Technical approach is weighted at forty percent of the total score.",
      "Cost is weighted at thirty percent.",
      "Past municipal experience is weighted at the remaining thirty percent.",
      "The City may shortlist up to four vendors for interviews.",
      ...filler("evaluation", 20),
    ],
  ],
  expectations: [
    { question: "When are proposals due?", fact: "14 March 2027", page: 2, kind: "supported" },
    { question: "What is the total contract ceiling?", fact: "485,000", page: 3, kind: "supported" },
    { question: "What is the invoice payment term?", fact: "45", page: 3, kind: "supported",
      note: "the question that was flatly refused before plural folding" },
    { question: "How much cyber liability insurance is required?", fact: "2,000,000", page: 4, kind: "supported" },
    { question: "How is cost weighted in the evaluation?", fact: "thirty percent", alsoAccept: ["30 percent", "30%"], page: 5, kind: "supported" },
    { question: "What is the bond percentage?", fact: "ten percent", page: 4, kind: "supported",
      note: "one matched term, and the answer IS in the document — the collision case" },
    { question: "What is the penalty for late delivery of hardware?", kind: "unsupported",
      note: "matches 'late' only; scored identically to the invoice question" },
    { question: "Who is the incumbent vendor's chief executive?", kind: "unsupported" },
    { question: "What uptime percentage must be met monthly?", kind: "misleading",
      note: "'percent' appears four times across pages 4 and 5, about entirely different things" },
    { question: "What is the cost of the performance bond in dollars?", kind: "misleading",
      note: "every term appears; the dollar figure does not exist" },
  ],
};

const AGREEMENT: Corpus = {
  name: "services-agreement.pdf",
  pages: [
    [
      "Professional Services Agreement",
      "This Agreement is made between the City of Ashgrove and the Vendor named in the signature block, and governs the services described in the attached statement of work.",
      "The parties agree that this Agreement supersedes all prior discussions and that no change is binding unless signed by both parties.",
      ...filler("contractual", 22),
    ],
    [
      "Term and Termination",
      "The initial term runs for thirty-six months from the effective date.",
      "Either party may terminate for convenience with ninety days written notice.",
      "The City may terminate immediately for cause if a material breach is not cured within thirty days of written notice.",
      "On termination the Vendor shall return or destroy City data within sixty days and certify that it has done so.",
      ...filler("termination", 20),
    ],
    [
      "Service Levels",
      "Uptime must meet ninety-nine point five percent measured monthly.",
      "Credits of five percent of monthly fees apply for each full hour of unplanned downtime, capped at fifty percent of the monthly fee.",
      "Planned maintenance is excluded if announced at least seventy-two hours in advance.",
      ...filler("service level", 21),
    ],
    [
      "Confidentiality and Data Handling",
      "Each party shall protect the other's confidential information with no less care than it applies to its own.",
      "The Vendor shall not transfer City data outside the United States without prior written consent.",
      "Subcontractors must be disclosed in writing and are bound by equivalent obligations.",
      ...filler("confidentiality", 21),
    ],
  ],
  expectations: [
    { question: "How long is the initial term?", fact: "thirty-six", alsoAccept: ["36 months", "36-month", "three years"], page: 2, kind: "supported" },
    { question: "What notice is needed to terminate for convenience?", fact: "ninety days", page: 2, kind: "supported" },
    { question: "What uptime percentage must be met monthly?", fact: "ninety-nine", alsoAccept: ["99.5", "99.5%"], page: 3, kind: "supported",
      note: "the same question that must be refused on the RFP" },
    { question: "Can City data be sent outside the United States?", fact: "written consent", page: 4, kind: "supported" },
    { question: "What is the total contract ceiling?", kind: "unsupported",
      note: "answerable from the RFP, absent here — retrieval is single-document" },
    { question: "What is the penalty for a data breach?", kind: "misleading",
      note: "'data' appears on three pages; there is no breach penalty anywhere" },
    { question: "How many days notice is required for planned maintenance in writing?", kind: "misleading",
      note: "notice, days and writing all appear repeatedly; the maintenance figure is in hours, not days" },
  ],
};

const POLICY: Corpus = {
  name: "records-retention-policy.pdf",
  pages: [
    [
      "Records Retention Policy",
      "This policy describes how long the City retains records, who may dispose of them, and how disposal is documented. It applies to records in any format.",
      "Retention periods begin at the end of the fiscal year in which the record was created, unless this policy states otherwise.",
      ...filler("retention", 22),
    ],
    [
      "Retention Periods",
      "Council minutes are retained permanently.",
      "Purchasing records are retained for seven years after final payment.",
      "Routine correspondence is retained for two years.",
      "Personnel records are retained for sixty years after separation.",
      ...filler("retention period", 21),
    ],
    [
      "Disposal and Certification",
      "Disposal requires written authorisation from the Records Officer.",
      "A certificate of destruction must be retained for ten years after disposal.",
      "Records subject to a litigation hold must not be disposed of regardless of their retention period.",
      ...filler("disposal", 21),
    ],
  ],
  expectations: [
    { question: "How long are purchasing records retained?", fact: "seven years", page: 2, kind: "supported" },
    { question: "How long must a certificate of destruction be kept?", fact: "ten years", page: 3, kind: "supported" },
    { question: "Who authorises disposal?", fact: "Records Officer", page: 3, kind: "supported" },
    { question: "How long are records retained after a retention hold is lifted?", kind: "misleading",
      note: "retained, records, retention and hold all appear; this period does not exist" },
    { question: "What is the retention period for video surveillance footage?", kind: "misleading",
      note: "retention period is on every page; footage is nowhere" },
    { question: "Which officer approves the annual retention budget?", kind: "misleading",
      note: "officer, approves, annual and retention all appear separately" },
  ],
};

export const CORPUS: Corpus[] = [RFP, AGREEMENT, POLICY];
