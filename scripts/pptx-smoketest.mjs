import { writeFileSync } from "node:fs";
import { buildPptx } from "../shared/pptx-lite.mjs";

const deck = {
  title: "Weekly Executive Summary",
  subtitle: "GCIO portfolio · 17 – 23 August 2026 · 59 projects",
  footer: "GCIO Project Intelligence · demonstration portfolio",
  slides: [
    { cover: true, eyebrow: "GCIO · PROJECT INTELLIGENCE", title: "Weekly Executive Summary",
      subtitle: "17 – 23 August 2026 · 59 projects · AED 265.9M committed",
      kpis: [{ lab: "Portfolio", val: "59", sub: "47 active" }, { lab: "Healthy", val: "64%", sub: "38 green" },
             { lab: "Committed", val: "AED 265.9M", sub: "64% consumed" }, { lab: "Overdue", val: "6", sub: "4 milestones" }] },
    { eyebrow: "Section 1", title: "Successes",
      kpis: [{ lab: "Delivered", val: "3" }, { lab: "Milestones closed", val: "5" }, { lab: "Near complete", val: "2" }],
      bullets: [
        { tag: "Delivered", tone: "good", text: "Government Cloud Landing Zone", sub: "Closed 18 Aug — AED 5.0M of AED 5.4M, under budget by AED 420K." },
        { tag: "Delivered", tone: "good", text: "HR Payroll Cloud Migration", sub: "Closed 19 Aug — AED 2.7M of AED 2.9M." },
        { tag: "90%+", tone: "info", text: "Citizen Services Portal Rewrite", sub: "93% complete, target 5 Sep." },
      ] },
    { eyebrow: "Section 2", title: "Questions, Risks & Issues", dense: true,
      bullets: [
        { tag: "Decision now", tone: "bad", text: "Approve the 6-week re-baseline of Core Network Segmentation?", sub: "P-1108 · S. Rahman · needed by 29 Aug" },
        { tag: "Risk", tone: "warn", text: "Federation gateway vendor cannot meet SIT date", sub: "P-1042 · escalated to procurement" },
        { tag: "Issue", tone: "bad", text: "Legacy ERP on hold 47 days awaiting finance decision", sub: "P-0834 · blocks AED 23.4M of dependent work" },
      ], note: "Derived questions are inferred from portfolio state." },
    { eyebrow: "Section 3", title: "Priorities",
      bullets: [{ tag: "1", tone: "bad", text: "Core Network Segmentation — urgency 94", sub: "Needed: decide re-baseline vs de-scope at the 27 Aug CAB." }] },
    { eyebrow: "Section 4", title: "Roadmap / Planned Projects",
      bullets: [{ tag: "Approved", tone: "good", text: "AI Document Triage Pilot", sub: "Starts 15 Sep 2026 · AED 2.4M" }] },
  ],
};

const bytes = buildPptx(deck);
writeFileSync("exports/smoketest.pptx", bytes);
console.log("wrote exports/smoketest.pptx", bytes.length, "bytes,", deck.slides.length, "slides");
