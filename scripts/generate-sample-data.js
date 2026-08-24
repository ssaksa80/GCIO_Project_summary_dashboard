#!/usr/bin/env node
/**
 * GCIO Project Intelligence — sample portfolio generator (SPEC §9).
 *
 * Deterministic (mulberry32, seed 20260823). "Today" is hardcoded to 2026-08-23 —
 * no Date.now() anywhere. Produces four workbooks in sample-data/:
 *
 *   GCIO_Portfolio_Master.xlsx   34 projects (PRJ-1xxx) + Milestones/Updates/Risks sheets (exceljs, styled)
 *   Dept_DigitalHealth.xlsx      10 projects (PRJ-2xxx), alternate header spellings (exceljs)
 *   Dept_Cybersecurity.xlsx       8 projects (PRJ-3xxx), a third header variant (exceljs)
 *   Dept_Infrastructure.xls       7 projects (PRJ-4xxx), legacy BIFF8 via SheetJS, projects sheet only
 *
 * Department files carry ADDITIONAL projects (no id collisions with the master);
 * several of them point parentId at master program umbrellas to demonstrate
 * cross-file hierarchy chains. Run: node scripts/generate-sample-data.js
 */

import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

// The standalone ESM build of SheetJS needs an fs implementation for writeFile.
if (typeof XLSX.set_fs === "function") XLSX.set_fs(fs);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "sample-data");

/** Fixed "as of" date for the whole portfolio (SPEC §9). */
const TODAY = "2026-08-23";
const SEED = 20260823;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Seeded RNG                                                          */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 PRNG — returns a function yielding floats in [0, 1).
 * @param {number} seed 32-bit integer seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

/**
 * Uniform integer in [min, max] inclusive.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function rInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Uniform float in [min, max).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function rFloat(min, max) {
  return min + rng() * (max - min);
}

/**
 * Pick one element of a non-empty array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function rPick(arr) {
  return arr[rInt(0, arr.length - 1)];
}

/**
 * Pick `n` distinct elements of `arr`, preserving original order.
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[]}
 */
function sampleSorted(arr, n) {
  const want = Math.min(n, arr.length);
  const idx = new Set();
  while (idx.size < want) idx.add(rInt(0, arr.length - 1));
  return [...idx].sort((a, b) => a - b).map((i) => arr[i]);
}

/* ------------------------------------------------------------------ */
/* Date helpers (pure UTC math, ISO yyyy-mm-dd strings)                */
/* ------------------------------------------------------------------ */

/** @param {string} iso @returns {number} epoch ms at UTC midnight */
function toMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** @param {number} ms @returns {string} ISO yyyy-mm-dd */
function toIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Add (or subtract) whole days to an ISO date.
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
function addDays(iso, days) {
  return toIso(toMs(iso) + days * DAY_MS);
}

/**
 * Whole-day difference b - a.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/**
 * Clamp an ISO date into [min, max].
 * @param {string} iso
 * @param {string} min
 * @param {string} max
 * @returns {string}
 */
function clampIso(iso, min, max) {
  if (toMs(iso) < toMs(min)) return min;
  if (toMs(iso) > toMs(max)) return max;
  return iso;
}

/**
 * Linear interpolation between two ISO dates at fraction t (0..1).
 * @param {string} a
 * @param {string} b
 * @param {number} t
 * @returns {string}
 */
function lerpIso(a, b, t) {
  return toIso(Math.round(toMs(a) + (toMs(b) - toMs(a)) * t));
}

/** @param {string} iso @returns {string} dd/mm/yyyy (legacy .xls flavour) */
function toDmy(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Format an integer with thousands separators (locale-independent).
 * @param {number} n
 * @returns {string}
 */
function thousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ------------------------------------------------------------------ */
/* Name / text pools                                                   */
/* ------------------------------------------------------------------ */

const OWNERS = [
  "Mariam Al Suwaidi", "Ahmed Al Mansoori", "Fatima Al Zaabi", "Omar Al Shamsi",
  "Khalid Al Marzooqi", "Noura Al Kaabi", "Aisha Al Hammadi", "Saeed Al Falahi",
  "Priya Nair", "James O'Connor", "Li Wei Chen", "Sara Haddad",
  "Elena Petrova", "Ravi Subramanian", "Daniel Weber", "Grace Okafor", "Yusuf Khan",
];

const SPONSORS = [
  "Dr. Hessa Al Falasi", "Eng. Salem Al Nuaimi", "Mohammed Al Hashimi",
  "Amna Al Ali", "Saif Al Dhaheri", "Dr. Richard Hughes",
  "Dr. Vandana Sharma", "Catherine Dubois",
];

const VENDORS = [
  "Accenture", "IBM Consulting", "Microsoft", "Cisco", "Dell Technologies",
  "ServiceNow", "Injazat", "e& enterprise", "GE HealthCare", "Philips",
  "Nutanix", "Genesys", "AWS", "Splunk", "CrowdStrike",
];

const MILESTONE_POOL = [
  "Business Case Approved", "Vendor Contract Signed", "Solution Design Sign-off",
  "Environment Provisioning Complete", "Data Migration Dry Run", "Integration Testing Complete",
  "Security & Compliance Review", "UAT Sign-off", "Pilot Go-Live",
  "Training & Adoption Complete", "Production Go-Live", "Hypercare Exit", "Benefits Review",
];

const RISK_TITLES = [
  "Vendor resource attrition on critical path",
  "Integration dependency on legacy interface engine",
  "Data quality below migration threshold",
  "Regulatory compliance deadline (DoH/NESA) slippage",
  "Budget contingency exhaustion before go-live",
  "Change fatigue among clinical end users",
  "Third-party API instability in production",
  "Licensing cost escalation at contract renewal",
  "Key SME single point of failure",
  "Downtime window approval risk with operations",
  "Cutover rollback plan untested at scale",
  "Cross-program resource contention",
];

/** Update-text template pools, keyed by situation. Each entry is (project) => string. */
const UPDATE_LIB = {
  progress: [
    (p) => `Sprint review complete; delivery tracking at ${p.percentComplete}% with the critical path stable.`,
    (p) => `Steering committee endorsed the revised integration plan; ${p.vendor} has committed additional senior resources.`,
    () => "UAT defect burn-down is ahead of plan; clinical champions engaged for adoption readiness.",
    () => "Budget review completed with Finance; forecast remains within the approved envelope.",
    () => "Interface build with the enterprise service bus passed end-to-end validation in staging.",
    (p) => `Executive walkthrough delivered to the sponsor; ${p.owner} confirmed no change to the committed scope.`,
    () => "Testing exit criteria agreed with Quality & Patient Safety; entry into performance testing next week.",
  ],
  red: [
    (p) => `Recovery plan invoked: scope re-sequenced, weekly CIO checkpoint established, and ${p.vendor} penalties under review.`,
    () => "Escalation: data quality remains below the migration threshold; a joint remediation cell has been stood up.",
    () => "Schedule re-baseline submitted to the portfolio board; dependency on the legacy interface engine confirmed as root cause.",
  ],
  completedClose: [
    () => "Project formally closed. Hypercare exited with zero Sev-1 incidents; benefits realization transferred to the service owner.",
    () => "Closure report approved by the steering committee; residual actions handed to operations with owners and dates.",
  ],
  approved: [
    () => "Mobilization underway: delivery manager assigned, vendor SOW in legal review, and kickoff scheduled.",
    () => "Funding released by the Digital Investment Committee; resource onboarding and environment requests initiated.",
  ],
  proposed: [
    () => "Business case refined with Finance; TCO validated and submitted to the Digital Investment Committee.",
    () => "Discovery workshops completed with clinical stakeholders; benefits model circulated for sponsor endorsement.",
  ],
  onHold: [
    () => "Initiative paused pending vendor contract renegotiation; restart criteria agreed with the sponsor.",
    () => "On hold at the portfolio board's direction while enterprise architecture completes the platform review.",
  ],
  cancelled: [
    () => "Initiative cancelled following portfolio rebalancing; residual commitments settled and lessons captured.",
  ],
};

/* ------------------------------------------------------------------ */
/* Portfolio catalog                                                   */
/* ------------------------------------------------------------------ */
/*
 * Entry shape (hints; the builder fills everything else coherently):
 *   id, name, desc, dept, pillar, program, parentId, vendor?,
 *   status, health, tier ("P" parent | "L" | "M" | "S"), budget?,
 *   start?, target?, actualEnd?, approval?, pct?, overrun?, hot?, nearMs?, priority?
 */

const DEPT = {
  DH: "Digital Health",
  CY: "Cybersecurity",
  CI: "Cloud & Infrastructure",
  DA: "Data & AI",
  ERP: "ERP & Corporate Systems",
  PX: "Patient Experience",
  NT: "Network & Telecom",
};

const PILLAR = {
  DT: "Digital Transformation",
  OE: "Operational Excellence",
  PC: "Patient-Centric Care",
  IE: "Intelligent Enterprise",
  RS: "Resilience & Security",
};

const MASTER_CATALOG = [
  // ---- Program 1: OneCare EMR (parent + 5 children) ----
  { id: "PRJ-1001", name: "OneCare EMR Modernization Program", dept: DEPT.DH, pillar: PILLAR.DT, program: "OneCare EMR", tier: "P", budget: 45_000_000, vendor: "Epic Systems", status: "In Progress", health: "Amber", pct: 68, start: "2024-03-04", target: "2027-03-31", priority: "Critical", hot: true,
    desc: "Enterprise umbrella for replacing legacy EMRs with a single clinical record across all facilities." },
  { id: "PRJ-1002", name: "EMR Core Build & Clinical Configuration", dept: DEPT.DH, pillar: PILLAR.DT, program: "OneCare EMR", parentId: "PRJ-1001", tier: "L", vendor: "Epic Systems", status: "In Progress", health: "Green", pct: 74, nearMs: true,
    desc: "Core EMR module build, clinical content localization and specialty workflow configuration." },
  { id: "PRJ-1003", name: "Legacy Data Migration Factory", dept: DEPT.DH, pillar: PILLAR.DT, program: "OneCare EMR", parentId: "PRJ-1001", tier: "L", vendor: "Accenture", status: "In Progress", health: "Red", pct: 62, target: "2026-06-30", overrun: true, hot: true, priority: "Critical",
    desc: "Extraction, cleansing and conversion of 14 years of patient records from three legacy systems." },
  { id: "PRJ-1004", name: "Clinical Order Sets & CPOE Rollout", dept: DEPT.DH, pillar: PILLAR.PC, program: "OneCare EMR", parentId: "PRJ-1001", tier: "M", vendor: "Epic Systems", status: "Completed", health: "Green", target: "2026-08-14", actualEnd: "2026-08-19", hot: true,
    desc: "Standardized evidence-based order sets and computerized provider order entry across inpatient units." },
  { id: "PRJ-1005", name: "e-Prescribing & Pharmacy Integration", dept: DEPT.DH, pillar: PILLAR.PC, program: "OneCare EMR", parentId: "PRJ-1001", tier: "M", vendor: "Epic Systems", status: "In Progress", health: "Amber",
    desc: "Closed-loop medication management integrating e-prescribing with pharmacy dispensing systems." },
  { id: "PRJ-1006", name: "Go-Live Command Center & Training", dept: DEPT.DH, pillar: PILLAR.OE, program: "OneCare EMR", parentId: "PRJ-1001", tier: "M", vendor: "Accenture", status: "Approved", health: "Green", approval: "2026-07-10", start: "2026-10-01",
    desc: "At-the-elbow support model, super-user network and 24x7 command center for EMR go-live waves." },

  // ---- Program 2: Fortress Cyber Resilience (parent + 5 children) ----
  { id: "PRJ-1010", name: "Fortress Cyber Resilience Program", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", tier: "P", budget: 30_000_000, vendor: "CrowdStrike", status: "In Progress", health: "Green", pct: 72, start: "2024-09-02", target: "2026-12-31", priority: "Critical", hot: true,
    desc: "Umbrella program uplifting cyber defense, detection and response to national regulatory standards." },
  { id: "PRJ-1011", name: "Next-Gen SIEM Rollout", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "L", vendor: "Splunk", status: "In Progress", health: "Green", pct: 80, nearMs: true,
    desc: "Cloud-native SIEM with curated healthcare detection content replacing the end-of-life platform." },
  { id: "PRJ-1012", name: "Zero Trust Network Access", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "M", vendor: "Cisco", status: "In Progress", health: "Green",
    desc: "Identity-aware access replacing legacy VPN for workforce, third parties and remote clinicians." },
  { id: "PRJ-1013", name: "Medical Device Security (IoMT)", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "M", vendor: "Cisco", status: "In Progress", health: "Red", pct: 58, target: "2026-07-15", priority: "High",
    desc: "Discovery, segmentation and monitoring of connected medical devices across clinical networks." },
  { id: "PRJ-1014", name: "Privileged Access Management", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "M", vendor: "IBM Consulting", status: "Completed", health: "Green", target: "2026-06-05", actualEnd: "2026-06-12",
    desc: "Vaulting, session recording and just-in-time elevation for all privileged accounts." },
  { id: "PRJ-1015", name: "24x7 SOC Managed Detection & Response", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "M", vendor: "e& enterprise", status: "In Progress", health: "Green",
    desc: "Co-managed security operations center with round-the-clock monitoring and incident response." },

  // ---- Program 3: Insight Data & AI (parent + 4 children) ----
  { id: "PRJ-1020", name: "Insight Data & AI Program", dept: DEPT.DA, pillar: PILLAR.IE, program: "Insight", tier: "P", budget: 24_000_000, vendor: "Microsoft", status: "In Progress", health: "Green", pct: 45, start: "2025-01-13", target: "2027-06-30", priority: "Critical",
    desc: "Umbrella program building the enterprise data platform and scaling responsible clinical AI." },
  { id: "PRJ-1021", name: "Enterprise Data Lakehouse", dept: DEPT.DA, pillar: PILLAR.IE, program: "Insight", parentId: "PRJ-1020", tier: "L", vendor: "Microsoft", status: "In Progress", health: "Amber", nearMs: true,
    desc: "Unified lakehouse consolidating clinical, operational and financial data with governed access." },
  { id: "PRJ-1022", name: "Clinical AI Decision Support Pilots", dept: DEPT.DA, pillar: PILLAR.PC, program: "Insight", parentId: "PRJ-1020", tier: "M", vendor: "GE HealthCare", status: "Approved", health: "Green", approval: "2026-08-18", start: "2026-09-07", hot: true,
    desc: "Sepsis early-warning and radiology worklist prioritization pilots under clinical governance." },
  { id: "PRJ-1023", name: "Population Health Analytics", dept: DEPT.DA, pillar: PILLAR.PC, program: "Insight", parentId: "PRJ-1020", tier: "M", status: "Proposed", health: "Green",
    desc: "Risk stratification and chronic disease registries to support proactive outreach programs." },
  { id: "PRJ-1024", name: "Master Patient Index Remediation", dept: DEPT.DA, pillar: PILLAR.OE, program: "Insight", parentId: "PRJ-1020", tier: "M", vendor: "IBM Consulting", status: "Completed", health: "Green", target: "2026-06-15", actualEnd: "2026-05-28",
    desc: "Duplicate record resolution and probabilistic matching uplift for a trusted patient identity." },

  // ---- Program 4: Horizon Cloud & ERP (parent + 4 children) ----
  { id: "PRJ-1030", name: "Horizon Cloud & ERP Program", dept: DEPT.ERP, pillar: PILLAR.IE, program: "Horizon", tier: "P", budget: 38_000_000, vendor: "SAP", status: "In Progress", health: "Amber", pct: 63, start: "2024-06-10", target: "2026-11-30", priority: "Critical",
    desc: "Umbrella program moving corporate systems to cloud ERP and exiting the primary data center." },
  { id: "PRJ-1031", name: "ERP Cloud Migration (Finance & Supply Chain)", dept: DEPT.ERP, pillar: PILLAR.IE, program: "Horizon", parentId: "PRJ-1030", tier: "L", vendor: "SAP", status: "In Progress", health: "Red", pct: 71, target: "2026-07-31", overrun: true, hot: true, priority: "Critical",
    desc: "Greenfield S/4HANA implementation for finance, procurement and supply chain with data conversion." },
  { id: "PRJ-1032", name: "HR & Payroll Cloud Transition", dept: DEPT.ERP, pillar: PILLAR.OE, program: "Horizon", parentId: "PRJ-1030", tier: "M", vendor: "SAP", status: "Completed", health: "Green", target: "2026-08-31", actualEnd: "2026-08-21", hot: true,
    desc: "SuccessFactors core HR, payroll and self-service rollout for 12,000 employees." },
  { id: "PRJ-1033", name: "Data Center Exit & Cloud Landing Zone", dept: DEPT.ERP, pillar: PILLAR.RS, program: "Horizon", parentId: "PRJ-1030", tier: "L", vendor: "AWS", status: "In Progress", health: "Amber",
    desc: "Secure landing zone, migration factory and decommissioning plan for the primary data center." },
  { id: "PRJ-1034", name: "Integration Platform (iPaaS) Buildout", dept: DEPT.ERP, pillar: PILLAR.IE, program: "Horizon", parentId: "PRJ-1030", tier: "M", vendor: "Microsoft", status: "In Progress", health: "Green",
    desc: "Enterprise integration platform replacing point-to-point interfaces with governed APIs." },

  // ---- Standalone initiatives (12) ----
  { id: "PRJ-1040", name: "Aman Patient App 2.0", dept: DEPT.PX, pillar: PILLAR.PC, tier: "L", vendor: "Accenture", status: "In Progress", health: "Green", nearMs: true,
    desc: "Next-generation patient app: appointments, results, payments and virtual queue in one journey." },
  { id: "PRJ-1041", name: "Telehealth Expansion Wave 3", dept: DEPT.DH, pillar: PILLAR.PC, tier: "M", vendor: "Philips", status: "In Progress", health: "Green",
    desc: "Extending virtual consultations to dermatology, mental health and post-surgical follow-up." },
  { id: "PRJ-1042", name: "Contact Center AI Virtual Agent", dept: DEPT.PX, pillar: PILLAR.IE, tier: "M", vendor: "Genesys", status: "In Progress", health: "Amber", hot: true,
    desc: "Arabic/English conversational AI deflecting routine calls and booking appointments end to end." },
  { id: "PRJ-1043", name: "Clinical Network Segmentation", dept: DEPT.NT, pillar: PILLAR.RS, tier: "M", vendor: "Cisco", status: "On Hold", health: "Amber",
    desc: "Micro-segmentation of clinical VLANs isolating biomedical, guest and corporate traffic." },
  { id: "PRJ-1044", name: "Hospital Wi-Fi 6E Refresh", dept: DEPT.NT, pillar: PILLAR.OE, tier: "M", vendor: "Cisco", status: "Completed", health: "Green", target: "2026-07-20", actualEnd: "2026-07-29",
    desc: "Campus-wide wireless refresh for clinical mobility, RTLS readiness and guest services." },
  { id: "PRJ-1045", name: "RIS/PACS Upgrade & Vendor-Neutral Archive", dept: DEPT.DH, pillar: PILLAR.DT, tier: "L", vendor: "GE HealthCare", status: "In Progress", health: "Green",
    desc: "Radiology platform upgrade with a vendor-neutral archive consolidating enterprise imaging." },
  { id: "PRJ-1046", name: "Pharmacy Automation Robotics Integration", dept: DEPT.DH, pillar: PILLAR.OE, tier: "M", vendor: "Philips", status: "Cancelled", health: "Amber",
    desc: "Robotic dispensing integration cancelled after vendor exit from the regional market." },
  { id: "PRJ-1047", name: "SD-WAN for Remote Clinics", dept: DEPT.NT, pillar: PILLAR.RS, tier: "M", vendor: "Cisco", status: "In Progress", health: "Green",
    desc: "Resilient software-defined WAN with local breakout for 23 remote clinics and field units." },
  { id: "PRJ-1048", name: "Endpoint Modernization (Windows 11)", dept: DEPT.CI, pillar: PILLAR.OE, tier: "M", vendor: "Dell Technologies", status: "In Progress", health: "Green",
    desc: "Fleet refresh and zero-touch provisioning for 9,500 clinical and corporate endpoints." },
  { id: "PRJ-1049", name: "Disaster Recovery as a Service", dept: DEPT.CI, pillar: PILLAR.RS, tier: "M", vendor: "AWS", status: "Approved", health: "Green", approval: "2026-08-20", start: "2026-09-14", hot: true,
    desc: "Cloud-based DR for tier-1 clinical systems with automated failover runbooks and testing." },
  { id: "PRJ-1050", name: "Patient Flow RTLS", dept: DEPT.PX, pillar: PILLAR.OE, tier: "M", vendor: "Philips", status: "On Hold", health: "Red", priority: "High",
    desc: "Real-time location services for patient flow, asset tracking and bed turnover analytics." },
  { id: "PRJ-1051", name: "Procurement Punch-Out & e-Invoicing", dept: DEPT.ERP, pillar: PILLAR.OE, tier: "S", status: "Proposed", health: "Green",
    desc: "Supplier punch-out catalogs and UAE e-invoicing compliance for the procure-to-pay cycle." },
];

const DIGITAL_HEALTH_CATALOG = [
  { id: "PRJ-2001", name: "Ambulatory EMR Extension", dept: DEPT.DH, pillar: PILLAR.DT, program: "OneCare EMR", parentId: "PRJ-1001", tier: "M", vendor: "Epic Systems", status: "In Progress", health: "Amber",
    desc: "Extending the OneCare EMR build to ambulatory clinics and specialty outpatient centers." },
  { id: "PRJ-2002", name: "Patient Portal Lab Results Release", dept: DEPT.DH, pillar: PILLAR.PC, program: "OneCare EMR", parentId: "PRJ-1001", tier: "S", vendor: "Epic Systems", status: "In Progress", health: "Green",
    desc: "Automated, clinically governed release of laboratory results to the patient portal." },
  { id: "PRJ-2003", name: "Nursing e-Observations Rollout", dept: DEPT.DH, pillar: PILLAR.PC, tier: "M", vendor: "Philips", status: "In Progress", health: "Green", nearMs: true,
    desc: "Digital vital-signs capture with early-warning scoring at the bedside across wards." },
  { id: "PRJ-2004", name: "Smart Bed Integration Pilot", dept: DEPT.DH, pillar: PILLAR.IE, tier: "S", vendor: "Philips", status: "In Progress", health: "Amber",
    desc: "Connected smart beds streaming pressure and exit alarms into the nursing dashboard." },
  { id: "PRJ-2005", name: "Voice Dictation for Clinicians", dept: DEPT.DH, pillar: PILLAR.OE, tier: "S", vendor: "Microsoft", status: "Completed", health: "Green", target: "2026-08-10", actualEnd: "2026-08-18", hot: true,
    desc: "Ambient speech-to-text clinical documentation embedded in the EMR for 1,200 physicians." },
  { id: "PRJ-2006", name: "Clinical Photography App", dept: DEPT.DH, pillar: PILLAR.PC, tier: "S", status: "In Progress", health: "Green", approval: "2026-08-10", start: "2026-08-17", target: "2027-02-26", pct: 15,
    desc: "Secure wound and dermatology photography flowing directly into the patient record." },
  { id: "PRJ-2007", name: "Imaging AI Triage", dept: DEPT.DA, pillar: PILLAR.IE, program: "Insight", parentId: "PRJ-1020", tier: "M", vendor: "GE HealthCare", status: "In Progress", health: "Green",
    desc: "AI triage of chest X-rays and CT heads prioritizing critical findings for radiologists." },
  { id: "PRJ-2008", name: "Digital Consent Workflow", dept: DEPT.DH, pillar: PILLAR.PC, tier: "S", status: "Approved", health: "Green", approval: "2026-08-17", start: "2026-09-02", hot: true,
    desc: "Paperless surgical and procedural consent with multilingual forms and e-signature." },
  { id: "PRJ-2009", name: "Bedside Tablet Experience", dept: DEPT.PX, pillar: PILLAR.PC, tier: "S", status: "Proposed", health: "Green",
    desc: "Bedside tablets for meal ordering, education content and environment controls." },
  { id: "PRJ-2010", name: "e-Referrals Interoperability Gateway", dept: DEPT.DH, pillar: PILLAR.DT, tier: "M", vendor: "Injazat", status: "In Progress", health: "Red", pct: 55, target: "2026-08-05", priority: "High", hot: true,
    desc: "National e-referral exchange gateway conforming to federal interoperability standards." },
];

const CYBERSECURITY_CATALOG = [
  { id: "PRJ-3001", name: "OT & Building Management Security Assessment", dept: DEPT.CY, pillar: PILLAR.RS, tier: "S", vendor: "e& enterprise", status: "In Progress", health: "Red", pct: 60, target: "2026-06-15", priority: "High",
    desc: "Security assessment and remediation roadmap for building management and OT systems." },
  { id: "PRJ-3002", name: "Phishing Simulation & Awareness Program", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "S", vendor: "CrowdStrike", status: "In Progress", health: "Green",
    desc: "Continuous phishing simulation with role-based awareness training and executive reporting." },
  { id: "PRJ-3003", name: "Data Loss Prevention Rollout", dept: DEPT.CY, pillar: PILLAR.RS, program: "Fortress", parentId: "PRJ-1010", tier: "M", vendor: "Microsoft", status: "In Progress", health: "Amber",
    desc: "Endpoint and cloud DLP policies protecting patient data across email, web and removable media." },
  { id: "PRJ-3004", name: "Vulnerability Management Uplift", dept: DEPT.CY, pillar: PILLAR.RS, tier: "S", vendor: "Splunk", status: "In Progress", health: "Green", nearMs: true,
    desc: "Risk-based vulnerability prioritization with SLA-driven remediation workflows in ITSM." },
  { id: "PRJ-3005", name: "Identity Governance & Administration", dept: DEPT.CY, pillar: PILLAR.RS, tier: "M", vendor: "IBM Consulting", status: "In Progress", health: "Amber",
    desc: "Joiner-mover-leaver automation, access certification and role mining for clinical systems." },
  { id: "PRJ-3006", name: "Email Security Gateway Replacement", dept: DEPT.CY, pillar: PILLAR.RS, tier: "S", vendor: "Microsoft", status: "Completed", health: "Green", target: "2026-08-28", actualEnd: "2026-08-22", hot: true,
    desc: "Cloud email security with impersonation protection replacing the legacy on-premise gateway." },
  { id: "PRJ-3007", name: "Red Team Exercise 2026", dept: DEPT.CY, pillar: PILLAR.RS, tier: "S", vendor: "CrowdStrike", status: "Approved", health: "Green", approval: "2026-08-18", start: "2026-09-20", hot: true,
    desc: "Full-scope adversary simulation testing detection and response across clinical environments." },
  { id: "PRJ-3008", name: "Backup Immutability & Ransomware Vault", dept: DEPT.CY, pillar: PILLAR.RS, tier: "M", vendor: "Dell Technologies", status: "In Progress", health: "Green",
    desc: "Immutable backup copies and an isolated recovery vault for tier-1 clinical workloads." },
];

const INFRASTRUCTURE_CATALOG = [
  { id: "PRJ-4001", name: "Server Fleet Refresh Wave 2", dept: DEPT.CI, pillar: PILLAR.OE, tier: "M", vendor: "Dell Technologies", status: "In Progress", health: "Green", nearMs: true,
    desc: "Lifecycle replacement of end-of-support compute with consolidation onto fewer hosts." },
  { id: "PRJ-4002", name: "Hyperconverged Platform for Clinical Apps", dept: DEPT.CI, pillar: PILLAR.RS, tier: "M", vendor: "Nutanix", status: "In Progress", health: "Amber",
    desc: "HCI platform hosting tier-1 clinical applications with stretched-cluster resilience." },
  { id: "PRJ-4003", name: "Cloud FinOps & Cost Optimization", dept: DEPT.CI, pillar: PILLAR.OE, program: "Horizon", parentId: "PRJ-1030", tier: "S", vendor: "AWS", status: "In Progress", health: "Green",
    desc: "Tagging standards, rightsizing and reserved-capacity governance across cloud accounts." },
  { id: "PRJ-4004", name: "Storage Lifecycle & Archive Tiering", dept: DEPT.CI, pillar: PILLAR.OE, tier: "S", status: "Proposed", health: "Green",
    desc: "Policy-driven tiering of aging imaging and document data to lower-cost archive storage." },
  { id: "PRJ-4005", name: "Data Center UPS & Cooling Upgrade", dept: DEPT.CI, pillar: PILLAR.RS, tier: "M", vendor: "Injazat", status: "In Progress", health: "Red", pct: 66, target: "2026-08-01", overrun: true, priority: "High",
    desc: "Critical power and cooling modernization sustaining the data center until cloud exit." },
  { id: "PRJ-4006", name: "Kubernetes Platform Standardization", dept: DEPT.CI, pillar: PILLAR.IE, program: "Horizon", parentId: "PRJ-1030", tier: "S", vendor: "AWS", status: "In Progress", health: "Green",
    desc: "Golden-path container platform with policy guardrails for internal product teams." },
  { id: "PRJ-4007", name: "Branch Clinic Edge Compute", dept: DEPT.CI, pillar: PILLAR.RS, tier: "S", vendor: "Nutanix", status: "On Hold", health: "Amber",
    desc: "Ruggedized edge nodes keeping clinic registration and imaging local during WAN outages." },
];

/* ------------------------------------------------------------------ */
/* Project builder                                                     */
/* ------------------------------------------------------------------ */

const BUDGET_BANDS = { L: [8_000_000, 20_000_000], M: [2_000_000, 8_000_000], S: [400_000, 2_000_000] };

/**
 * Derive coherent core dates for a project from its catalog hints.
 * Guarantees approval <= start <= target and actualEnd only for Completed.
 * @param {object} e catalog entry
 * @returns {{approvalDate: string|null, startDate: string, targetEndDate: string, actualEndDate: string|null}}
 */
function deriveDates(e) {
  let start = e.start ?? null;
  let target = e.target ?? null;
  let actualEnd = null;

  switch (e.status) {
    case "Completed": {
      actualEnd = e.actualEnd ?? addDays(TODAY, -rInt(30, 400));
      target = target ?? addDays(actualEnd, rInt(-10, 21));
      start = start ?? addDays(actualEnd, -rInt(240, 540));
      break;
    }
    case "In Progress": {
      if (target && !start) start = addDays(target, -rInt(380, 620));
      if (!start) start = addDays(TODAY, -rInt(120, 700));
      if (!target) {
        target = addDays(start, rInt(240, 600));
        if (daysBetween(TODAY, target) < 30) target = addDays(TODAY, rInt(45, 240));
      }
      break;
    }
    case "Approved": {
      const approval = e.approval ?? addDays(TODAY, -rInt(5, 40));
      start = start ?? addDays(approval, rInt(14, 60));
      target = target ?? addDays(start, rInt(200, 480));
      return { approvalDate: approval, startDate: start, targetEndDate: target, actualEndDate: null };
    }
    case "Proposed": {
      start = start ?? addDays(TODAY, rInt(30, 150));
      target = target ?? addDays(start, rInt(200, 420));
      return { approvalDate: null, startDate: start, targetEndDate: target, actualEndDate: null };
    }
    case "On Hold": {
      start = start ?? addDays(TODAY, -rInt(200, 500));
      target = target ?? addDays(TODAY, rInt(30, 200));
      break;
    }
    case "Cancelled": {
      start = start ?? addDays(TODAY, -rInt(300, 600));
      target = target ?? addDays(start, rInt(240, 480));
      break;
    }
    default:
      throw new Error(`Unknown status "${e.status}" on ${e.id}`);
  }

  if (toMs(target) < toMs(start)) target = addDays(start, rInt(200, 400));
  const approval = e.approval ?? addDays(start, -rInt(15, 90));
  return { approvalDate: approval, startDate: start, targetEndDate: target, actualEndDate: actualEnd };
}

/**
 * Percent complete consistent with status (Completed=100, Proposed<=5, In Progress 15-90).
 * @param {object} e catalog entry
 * @param {{startDate: string, targetEndDate: string}} dates
 * @returns {number}
 */
function derivePercent(e, dates) {
  if (e.status === "Completed") return 100;
  if (typeof e.pct === "number") return e.pct;
  switch (e.status) {
    case "Proposed": return rInt(0, 5);
    case "Approved": return rInt(0, 8);
    case "On Hold": return rInt(10, 60);
    case "Cancelled": return rInt(5, 40);
    default: {
      const span = Math.max(1, daysBetween(dates.startDate, dates.targetEndDate));
      const elapsed = Math.max(0, daysBetween(dates.startDate, TODAY)) / span;
      const raw = Math.round(elapsed * 100 * rFloat(0.75, 1.05));
      return Math.min(90, Math.max(15, raw));
    }
  }
}

/**
 * Spend that roughly tracks percent complete, capped at ~1.15x budget,
 * with deliberate overruns when the entry is flagged.
 * @param {object} e catalog entry
 * @param {number} budget
 * @param {number} pct
 * @returns {number}
 */
function deriveSpent(e, budget, pct) {
  let spent;
  if (e.status === "Proposed") spent = 0;
  else if (e.status === "Approved") spent = budget * rFloat(0, 0.03);
  else if (e.overrun) spent = budget * rFloat(1.03, 1.14);
  else if (e.status === "Completed") spent = budget * rFloat(0.88, 1.04);
  else if (e.status === "On Hold" || e.status === "Cancelled") spent = budget * (pct / 100) * rFloat(0.7, 1.0);
  else spent = budget * (pct / 100) * rFloat(0.8, 1.12);
  spent = Math.min(spent, budget * 1.15);
  return Math.round(spent / 1000) * 1000;
}

/**
 * Build 3-6 milestones spread across the project window. Past ones are mostly
 * Completed; Red/Amber active projects get 1-2 deliberate Overdue milestones;
 * `nearMs` entries get an extra milestone landing around 2026-08-23.
 * @param {object} e catalog entry
 * @param {object} p project under construction (dates + status + health set)
 * @returns {Array<{name: string, dueDate: string, completedDate: string|null, status: string}>}
 */
function buildMilestones(e, p) {
  const windowEnd = p.actualEndDate ?? p.targetEndDate;
  const n = rInt(3, 6);
  const names = sampleSorted(MILESTONE_POOL, n);
  const active = p.status === "In Progress" || p.status === "On Hold";
  let overdueQuota = active && (p.health === "Red" || p.health === "Amber") ? rInt(1, 2) : 0;

  const rows = names.map((name, i) => {
    let due = lerpIso(p.startDate, windowEnd, (i + 1) / (n + 0.3));
    due = clampIso(addDays(due, rInt(-10, 10)), p.startDate, windowEnd);
    return { name, dueDate: due, completedDate: null, status: "Pending" };
  });

  if (e.nearMs) {
    const due = clampIso(addDays(TODAY, rInt(-3, 6)), p.startDate, addDays(TODAY, 40));
    rows.push({ name: "Go/No-Go Readiness Review", dueDate: due, completedDate: null, status: "Pending" });
  }
  rows.sort((a, b) => toMs(a.dueDate) - toMs(b.dueDate));

  let flaggedUpcoming = false;
  for (const m of rows) {
    const past = toMs(m.dueDate) < toMs(TODAY);
    if (p.status === "Completed") {
      m.status = "Completed";
      m.completedDate = clampIso(addDays(m.dueDate, rInt(-7, 5)), p.startDate, p.actualEndDate);
    } else if (past) {
      if (overdueQuota > 0 && daysBetween(m.dueDate, TODAY) <= 150) {
        m.status = "Overdue";
        overdueQuota -= 1;
      } else {
        m.status = "Completed";
        m.completedDate = clampIso(addDays(m.dueDate, rInt(-6, 8)), p.startDate, TODAY);
      }
    } else if (p.status === "In Progress" && !flaggedUpcoming && rng() < 0.55) {
      m.status = "In Progress";
      flaggedUpcoming = true;
    }
  }
  return rows;
}

/**
 * Build 2-5 executive updates dated within the last 60 days. Entries flagged
 * `hot` are guaranteed a fresh update in the 2026-08-20..23 window.
 * @param {object} e catalog entry
 * @param {object} p project under construction
 * @returns {Array<{date: string, author: string, text: string}>}
 */
function buildUpdates(e, p) {
  const floor = addDays(TODAY, -59);
  const n = rInt(2, 5);
  let cursor = e.hot ? addDays(TODAY, -rInt(0, 3)) : addDays(TODAY, -rInt(2, 40));

  const latestPool =
    p.status === "Completed" ? UPDATE_LIB.completedClose
    : p.status === "Approved" ? UPDATE_LIB.approved
    : p.status === "Proposed" ? UPDATE_LIB.proposed
    : p.status === "On Hold" ? UPDATE_LIB.onHold
    : p.status === "Cancelled" ? UPDATE_LIB.cancelled
    : p.health === "Red" ? UPDATE_LIB.red
    : UPDATE_LIB.progress;

  const updates = [];
  for (let i = 0; i < n; i += 1) {
    if (toMs(cursor) < toMs(floor)) break;
    const pool = i === 0 ? latestPool : (p.health === "Red" && rng() < 0.4 ? UPDATE_LIB.red : UPDATE_LIB.progress);
    updates.push({ date: cursor, author: p.owner, text: rPick(pool)(p) });
    cursor = addDays(cursor, -rInt(8, 20));
  }
  return updates.reverse(); // ascending by date
}

/**
 * Build 0-4 risks with a severity mix; Red projects always carry at least
 * one open High/Critical risk.
 * @param {object} p project under construction
 * @returns {Array<{title: string, severity: string, status: string, owner: string}>}
 */
function buildRisks(p) {
  const n = p.health === "Red" ? rInt(2, 4) : p.health === "Amber" ? rInt(1, 3) : rInt(0, 2);
  const titles = sampleSorted(RISK_TITLES, n);
  const risks = titles.map((title) => {
    const roll = rng();
    const severity = roll < 0.3 ? "Low" : roll < 0.65 ? "Medium" : roll < 0.9 ? "High" : "Critical";
    const sRoll = rng();
    const status = sRoll < 0.5 ? "Open" : sRoll < 0.8 ? "Mitigating" : "Closed";
    return { title, severity, status, owner: rPick(OWNERS) };
  });
  if (p.health === "Red" && !risks.some((r) => (r.severity === "High" || r.severity === "Critical") && r.status !== "Closed")) {
    risks[0] = { ...risks[0], severity: rng() < 0.5 ? "High" : "Critical", status: "Open" };
  }
  return risks;
}

/**
 * Build one fully coherent project (canonical §2 shape, children arrays nested)
 * from a catalog entry.
 * @param {object} e catalog entry
 * @param {string} sourceFile workbook the project will live in
 * @returns {object} canonical project object
 */
function buildProject(e, sourceFile) {
  const dates = deriveDates(e);
  const percentComplete = derivePercent(e, dates);
  const [lo, hi] = e.tier === "P" ? [e.budget, e.budget] : BUDGET_BANDS[e.tier];
  const budget = e.budget ?? Math.round(rFloat(lo, hi) / 50_000) * 50_000;
  const spent = deriveSpent(e, budget, percentComplete);

  const priority = e.priority ?? (() => {
    const roll = rng();
    return roll < 0.1 ? "Critical" : roll < 0.45 ? "High" : roll < 0.85 ? "Medium" : "Low";
  })();

  const phase =
    e.status === "Proposed" ? "Initiation"
    : e.status === "Approved" ? "Planning"
    : e.status === "Completed" || e.status === "Cancelled" ? "Closure"
    : e.status === "On Hold" ? "Planning"
    : percentComplete > 75 ? "Monitoring" : "Execution";

  const project = {
    id: e.id,
    name: e.name,
    description: e.desc,
    department: e.dept,
    pillar: e.pillar,
    program: e.program ?? "",
    parentId: e.parentId ?? null,
    owner: rPick(OWNERS),
    sponsor: rPick(SPONSORS),
    vendor: e.vendor ?? rPick(VENDORS),
    status: e.status,
    health: e.health,
    priority,
    phase,
    approvalDate: dates.approvalDate,
    startDate: dates.startDate,
    targetEndDate: dates.targetEndDate,
    actualEndDate: dates.actualEndDate,
    budget,
    spent,
    currency: "AED",
    percentComplete,
    milestones: [],
    updates: [],
    risks: [],
    lastUpdated: TODAY,
    sourceFile,
  };

  project.milestones = buildMilestones(e, project);
  project.updates = buildUpdates(e, project);
  project.risks = buildRisks(project);
  project.lastUpdated = project.updates.length
    ? project.updates[project.updates.length - 1].date
    : addDays(TODAY, -rInt(0, 10));
  return project;
}

/* ------------------------------------------------------------------ */
/* Column layouts (per-file header spellings, SPEC §3 synonyms)        */
/* ------------------------------------------------------------------ */

/** @typedef {{h: string, w: number, get: (p: object) => (string|number|null)}} Col */

/** Master workbook — canonical spellings. @type {Col[]} */
const MASTER_COLS = [
  { h: "Project ID", w: 12, get: (p) => p.id },
  { h: "Project Name", w: 44, get: (p) => p.name },
  { h: "Description", w: 70, get: (p) => p.description },
  { h: "Department", w: 24, get: (p) => p.department },
  { h: "Strategic Pillar", w: 24, get: (p) => p.pillar },
  { h: "Program", w: 16, get: (p) => p.program },
  { h: "Parent Project ID", w: 16, get: (p) => p.parentId },
  { h: "Project Manager", w: 20, get: (p) => p.owner },
  { h: "Executive Sponsor", w: 20, get: (p) => p.sponsor },
  { h: "Vendor", w: 18, get: (p) => p.vendor },
  { h: "Status", w: 13, get: (p) => p.status },
  { h: "Health", w: 9, get: (p) => p.health },
  { h: "Priority", w: 10, get: (p) => p.priority },
  { h: "Phase", w: 12, get: (p) => p.phase },
  { h: "Approval Date", w: 13, get: (p) => p.approvalDate },
  { h: "Start Date", w: 12, get: (p) => p.startDate },
  { h: "Target End Date", w: 14, get: (p) => p.targetEndDate },
  { h: "Actual End Date", w: 14, get: (p) => p.actualEndDate },
  { h: "Budget", w: 13, get: (p) => p.budget },
  { h: "Spent", w: 13, get: (p) => p.spent },
  { h: "Currency", w: 9, get: (p) => p.currency },
  { h: "Percent Complete", w: 14, get: (p) => p.percentComplete },
  { h: "Last Updated", w: 13, get: (p) => p.lastUpdated },
];

/** Digital Health dept file — variant spellings ("PM", "RAG Status", "Target Completion", "Approved Budget"); RAG words + fractional progress exercise value normalization. @type {Col[]} */
const DIGITAL_HEALTH_COLS = [
  { h: "ID", w: 12, get: (p) => p.id },
  { h: "Title", w: 42, get: (p) => p.name },
  { h: "Summary", w: 68, get: (p) => p.description },
  { h: "Dept", w: 20, get: (p) => p.department },
  { h: "Strategic Pillar", w: 24, get: (p) => p.pillar },
  { h: "Programme", w: 16, get: (p) => p.program },
  { h: "Parent Project", w: 14, get: (p) => p.parentId },
  { h: "PM", w: 20, get: (p) => p.owner },
  { h: "Executive Sponsor", w: 20, get: (p) => p.sponsor },
  { h: "Supplier", w: 18, get: (p) => p.vendor },
  { h: "Project Status", w: 13, get: (p) => p.status },
  { h: "RAG Status", w: 10, get: (p) => ({ Green: "On Track", Amber: "At Risk", Red: "Off Track" }[p.health]) },
  { h: "Criticality", w: 10, get: (p) => p.priority },
  { h: "Project Phase", w: 12, get: (p) => p.phase },
  { h: "Approved On", w: 13, get: (p) => p.approvalDate },
  { h: "Kickoff Date", w: 12, get: (p) => p.startDate },
  { h: "Target Completion", w: 15, get: (p) => p.targetEndDate },
  { h: "Completion Date", w: 14, get: (p) => p.actualEndDate },
  { h: "Approved Budget", w: 14, get: (p) => p.budget },
  { h: "Spent To Date", w: 13, get: (p) => p.spent },
  { h: "Progress", w: 10, get: (p) => Math.round(p.percentComplete) / 100 },
  { h: "Updated On", w: 12, get: (p) => p.lastUpdated },
];

/** Cybersecurity dept file — a third spelling variant; single-letter RAG codes. @type {Col[]} */
const CYBERSECURITY_COLS = [
  { h: "PRJ ID", w: 12, get: (p) => p.id },
  { h: "Name", w: 42, get: (p) => p.name },
  { h: "Scope", w: 68, get: (p) => p.description },
  { h: "Business Unit", w: 18, get: (p) => p.department },
  { h: "Theme", w: 24, get: (p) => p.pillar },
  { h: "Portfolio", w: 14, get: (p) => p.program },
  { h: "Parent ID", w: 12, get: (p) => p.parentId },
  { h: "Project Manager", w: 20, get: (p) => p.owner },
  { h: "Exec Sponsor", w: 20, get: (p) => p.sponsor },
  { h: "Partner", w: 18, get: (p) => p.vendor },
  { h: "Status", w: 13, get: (p) => p.status },
  { h: "RAG", w: 7, get: (p) => p.health[0] },
  { h: "Priority", w: 10, get: (p) => p.priority },
  { h: "Current Phase", w: 12, get: (p) => p.phase },
  { h: "Date Approved", w: 13, get: (p) => p.approvalDate },
  { h: "Start", w: 12, get: (p) => p.startDate },
  { h: "Planned End", w: 12, get: (p) => p.targetEndDate },
  { h: "Actual End", w: 12, get: (p) => p.actualEndDate },
  { h: "Total Budget", w: 13, get: (p) => p.budget },
  { h: "Actuals", w: 13, get: (p) => p.spent },
  { h: "Pct Complete", w: 12, get: (p) => p.percentComplete },
  { h: "Last Modified", w: 13, get: (p) => p.lastUpdated },
];

/** Legacy .xls — fourth spelling variant with dd/mm/yyyy dates, "AED 1,250,000" money strings and health words. @type {Col[]} */
const LEGACY_COLS = [
  { h: "Project Code", w: 12, get: (p) => p.id },
  { h: "Project Name", w: 42, get: (p) => p.name },
  { h: "Objective", w: 64, get: (p) => p.description },
  { h: "Division", w: 22, get: (p) => p.department },
  { h: "Strategic Theme", w: 24, get: (p) => p.pillar },
  { h: "Program", w: 14, get: (p) => p.program },
  { h: "Parent", w: 12, get: (p) => p.parentId },
  { h: "Manager", w: 20, get: (p) => p.owner },
  { h: "Sponsor", w: 20, get: (p) => p.sponsor },
  { h: "Vendor", w: 18, get: (p) => p.vendor },
  { h: "Status", w: 16, get: (p) => ({ "In Progress": "Active", Completed: "Done", Proposed: "Pending Approval" }[p.status] ?? p.status) },
  { h: "Health Status", w: 11, get: (p) => ({ Green: "On Track", Amber: "At Risk", Red: "Off Track" }[p.health]) },
  { h: "Criticality", w: 10, get: (p) => p.priority },
  { h: "Phase", w: 12, get: (p) => p.phase },
  { h: "Approved", w: 12, get: (p) => (p.approvalDate ? toDmy(p.approvalDate) : null) },
  { h: "Start Date", w: 12, get: (p) => toDmy(p.startDate) },
  { h: "Due Date", w: 12, get: (p) => toDmy(p.targetEndDate) },
  { h: "Date Closed", w: 12, get: (p) => (p.actualEndDate ? toDmy(p.actualEndDate) : null) },
  { h: "Budget AED", w: 16, get: (p) => `AED ${thousands(p.budget)}` },
  { h: "Actual Spend", w: 16, get: (p) => (p.spent > 0 ? `AED ${thousands(p.spent)}` : "AED 0") },
  { h: "Completion", w: 11, get: (p) => p.percentComplete },
  { h: "Updated On", w: 12, get: (p) => toDmy(p.lastUpdated) },
];

/** Child-record sheet layouts (canonical spellings, joined by Project ID). */
const MILESTONE_COLS = [
  { h: "Project ID", w: 12 }, { h: "Name", w: 36 }, { h: "Due Date", w: 12 },
  { h: "Completed Date", w: 14 }, { h: "Status", w: 12 },
];
const UPDATE_COLS = [
  { h: "Project ID", w: 12 }, { h: "Date", w: 12 }, { h: "Author", w: 20 }, { h: "Text", w: 110 },
];
const RISK_COLS = [
  { h: "Project ID", w: 12 }, { h: "Title", w: 46 }, { h: "Severity", w: 10 },
  { h: "Status", w: 12 }, { h: "Owner", w: 20 },
];

/* ------------------------------------------------------------------ */
/* Workbook writers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Apply the brand header style (#101828 fill, white bold text, frozen row)
 * to row 1 of a worksheet.
 * @param {import("exceljs").Worksheet} ws
 * @param {number} colCount
 */
function styleHeaderRow(ws, colCount) {
  const row = ws.getRow(1);
  row.height = 22;
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF101828" } };
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true, size: 11, name: "Calibri" };
    cell.alignment = { vertical: "middle" };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Add a styled sheet to an exceljs workbook and fill it with rows.
 * @param {import("exceljs").Workbook} wb
 * @param {string} name sheet name
 * @param {Array<{h: string, w: number}>} cols
 * @param {Array<Array<string|number|null>>} rows
 * @returns {import("exceljs").Worksheet}
 */
function addSheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ header: c.h, width: c.w }));
  for (const r of rows) ws.addRow(r);
  styleHeaderRow(ws, cols.length);
  return ws;
}

/**
 * Flatten child-record arrays of a project list into sheet rows.
 * @param {object[]} projects
 * @returns {{milestones: Array<Array<*>>, updates: Array<Array<*>>, risks: Array<Array<*>>}}
 */
function flattenChildren(projects) {
  const milestones = [];
  const updates = [];
  const risks = [];
  for (const p of projects) {
    for (const m of p.milestones) milestones.push([p.id, m.name, m.dueDate, m.completedDate, m.status]);
    for (const u of p.updates) updates.push([p.id, u.date, u.author, u.text]);
    for (const r of p.risks) risks.push([p.id, r.title, r.severity, r.status, r.owner]);
  }
  return { milestones, updates, risks };
}

/**
 * Write an .xlsx workbook (Projects + Milestones + Updates + Risks) with the
 * given projects-sheet column layout.
 * @param {string} filePath absolute output path
 * @param {object[]} projects
 * @param {Col[]} projectCols
 * @returns {Promise<number>} number of sheets written
 */
async function writeXlsxWorkbook(filePath, projects, projectCols) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GCIO Project Intelligence";
  wb.created = new Date(`${TODAY}T08:00:00Z`);
  wb.modified = new Date(`${TODAY}T08:00:00Z`);

  const projRows = projects.map((p) => projectCols.map((c) => c.get(p)));
  const ws = addSheet(wb, "Projects", projectCols, projRows);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: projectCols.length } };

  const kids = flattenChildren(projects);
  addSheet(wb, "Milestones", MILESTONE_COLS, kids.milestones);
  addSheet(wb, "Updates", UPDATE_COLS, kids.updates);
  addSheet(wb, "Risks", RISK_COLS, kids.risks);

  await wb.xlsx.writeFile(filePath);
  return 4;
}

/**
 * Write the legacy BIFF8 .xls workbook via SheetJS (projects sheet only).
 * @param {string} filePath absolute output path
 * @param {object[]} projects
 * @returns {number} number of sheets written
 */
function writeLegacyXls(filePath, projects) {
  const aoa = [
    LEGACY_COLS.map((c) => c.h),
    ...projects.map((p) => LEGACY_COLS.map((c) => c.get(p))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = LEGACY_COLS.map((c) => ({ wch: c.w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Projects");
  XLSX.writeFile(wb, filePath, { bookType: "xls" });
  return 1;
}

/* ------------------------------------------------------------------ */
/* Validation & manifest                                               */
/* ------------------------------------------------------------------ */

/**
 * Sanity-check internal coherence of every generated project; throws on any
 * violation so a bad generation never ships silently.
 * @param {object[]} projects all projects across all files
 */
function validatePortfolio(projects) {
  const ids = new Set();
  const problems = [];
  for (const p of projects) {
    if (ids.has(p.id)) problems.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (p.approvalDate && toMs(p.approvalDate) > toMs(p.startDate)) problems.push(`${p.id}: approval after start`);
    if (toMs(p.startDate) > toMs(p.targetEndDate)) problems.push(`${p.id}: start after target`);
    if (p.actualEndDate && p.status !== "Completed") problems.push(`${p.id}: actualEnd on non-completed`);
    if (p.status === "Completed" && (!p.actualEndDate || p.percentComplete !== 100)) problems.push(`${p.id}: incoherent completion`);
    if (p.status === "Proposed" && p.percentComplete > 5) problems.push(`${p.id}: proposed > 5%`);
    if (p.status === "In Progress" && (p.percentComplete < 15 || p.percentComplete > 90)) problems.push(`${p.id}: in-progress % out of band`);
    if (p.spent > p.budget * 1.15 + 1) problems.push(`${p.id}: spent beyond 1.15x budget`);
    for (const m of p.milestones) {
      if (m.completedDate && toMs(m.completedDate) > toMs(TODAY)) problems.push(`${p.id}: milestone completed in the future`);
    }
  }
  for (const p of projects) {
    if (p.parentId && !ids.has(p.parentId)) problems.push(`${p.id}: dangling parentId ${p.parentId}`);
  }
  if (problems.length) throw new Error(`Portfolio validation failed:\n  ${problems.join("\n  ")}`);
}

/**
 * Print the run manifest as an aligned table.
 * @param {Array<{file: string, format: string, projects: number, sheets: number, bytes: number}>} rows
 */
function printManifest(rows) {
  const cols = [
    { key: "file", label: "File" },
    { key: "format", label: "Format" },
    { key: "projects", label: "Projects" },
    { key: "sheets", label: "Sheets" },
    { key: "size", label: "Size" },
  ];
  const data = rows.map((r) => ({
    file: r.file,
    format: r.format,
    projects: String(r.projects),
    sheets: String(r.sheets),
    size: `${(r.bytes / 1024).toFixed(1)} KB`,
  }));
  const widths = cols.map((c) => Math.max(c.label.length, ...data.map((d) => d[c.key].length)));
  const line = (parts, pad = " ") => `  ${parts.map((s, i) => s[i === 0 ? "padEnd" : "padEnd"](widths[i], pad)).join("  ")}`;
  console.log("");
  console.log(line(cols.map((c) => c.label)));
  console.log(line(widths.map(() => ""), "-"));
  for (const d of data) console.log(line(cols.map((c) => d[c.key])));
  const total = rows.reduce((s, r) => s + r.projects, 0);
  console.log(`\n  ${rows.length} workbooks, ${total} projects, as of ${TODAY} (seed ${SEED}).`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Generate the full sample portfolio and write all four workbooks.
 * @returns {Promise<void>}
 */
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Build order is fixed so RNG consumption — and therefore output — is deterministic.
  const master = MASTER_CATALOG.map((e) => buildProject(e, "GCIO_Portfolio_Master.xlsx"));
  const digitalHealth = DIGITAL_HEALTH_CATALOG.map((e) => buildProject(e, "Dept_DigitalHealth.xlsx"));
  const cybersecurity = CYBERSECURITY_CATALOG.map((e) => buildProject(e, "Dept_Cybersecurity.xlsx"));
  const infrastructure = INFRASTRUCTURE_CATALOG.map((e) => buildProject(e, "Dept_Infrastructure.xls"));

  validatePortfolio([...master, ...digitalHealth, ...cybersecurity, ...infrastructure]);

  const manifest = [];

  const targets = [
    { file: "GCIO_Portfolio_Master.xlsx", projects: master, cols: MASTER_COLS },
    { file: "Dept_DigitalHealth.xlsx", projects: digitalHealth, cols: DIGITAL_HEALTH_COLS },
    { file: "Dept_Cybersecurity.xlsx", projects: cybersecurity, cols: CYBERSECURITY_COLS },
  ];
  for (const t of targets) {
    const outPath = path.join(OUT_DIR, t.file);
    const sheets = await writeXlsxWorkbook(outPath, t.projects, t.cols);
    manifest.push({ file: t.file, format: "xlsx", projects: t.projects.length, sheets, bytes: fs.statSync(outPath).size });
  }

  const xlsPath = path.join(OUT_DIR, "Dept_Infrastructure.xls");
  const xlsSheets = writeLegacyXls(xlsPath, infrastructure);
  manifest.push({ file: "Dept_Infrastructure.xls", format: "xls (BIFF8)", projects: infrastructure.length, sheets: xlsSheets, bytes: fs.statSync(xlsPath).size });

  printManifest(manifest);
}

main().catch((err) => {
  console.error(`sample-data generation failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
