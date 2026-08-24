/**
 * The canonical portfolio workbook.
 *
 * One download that contains every sheet and every column the ingester
 * understands, an example row in each, dropdown validation on the vocabulary
 * columns, and a "Read me" sheet that states the accepted formats. A PM should
 * be able to open this, delete the example rows, paste their data, and drop it
 * into data/ without asking anyone anything.
 */
import ExcelJS from "exceljs";

const NAVY = "FF00205B";
const GREEN = "FF00B140";
const LIME = "FF97D700";
const WHITE = "FFFFFFFF";
const WELL = "FFF1F5FA";
const INK2 = "FF4A5C74";

export const STATUSES = ["Proposed", "Approved", "In Progress", "On Hold", "Completed", "Cancelled"];
export const HEALTHS = ["Green", "Amber", "Red"];
export const PRIORITIES = ["Critical", "High", "Medium", "Low"];
export const PHASES = ["Initiation", "Planning", "Execution", "Monitoring", "Closure"];
export const MILESTONE_STATUSES = ["Pending", "In Progress", "Completed", "Overdue"];
export const RISK_SEVERITIES = ["Low", "Medium", "High", "Critical"];
export const RISK_STATUSES = ["Open", "Mitigating", "Closed"];
export const QUESTION_STATUSES = ["Open", "Answered", "Closed"];

/**
 * Sheet definitions: column header, width, optional dropdown list, and the
 * value used in the example row.
 */
const SHEETS = [
  {
    name: "Projects",
    note: "One row per project. Project ID and Project Name are the only required columns — everything else improves the briefing.",
    columns: [
      { header: "Project ID", width: 14, example: "PRJ-1001", required: true },
      { header: "Project Name", width: 38, example: "Unified Digital Identity Platform", required: true },
      { header: "Description", width: 46, example: "Single sign-on and federated identity for all citizen-facing services." },
      { header: "Department", width: 22, example: "Digital Services" },
      { header: "Strategic Pillar", width: 22, example: "Digital Government" },
      { header: "Program", width: 24, example: "National Identity Programme" },
      { header: "Parent Project ID", width: 17, example: "" },
      { header: "Owner", width: 20, example: "H. Al Mazrouei" },
      { header: "Sponsor", width: 20, example: "CIO Office" },
      { header: "Vendor", width: 18, example: "Accenture" },
      { header: "Status", width: 14, example: "In Progress", list: STATUSES },
      { header: "Health", width: 10, example: "Amber", list: HEALTHS },
      { header: "Priority", width: 11, example: "Critical", list: PRIORITIES },
      { header: "Phase", width: 13, example: "Execution", list: PHASES },
      { header: "Approval Date", width: 15, example: new Date("2025-02-01"), date: true },
      { header: "Start Date", width: 13, example: new Date("2025-03-15"), date: true },
      { header: "Target End Date", width: 16, example: new Date("2026-11-30"), date: true },
      { header: "Actual End Date", width: 16, example: "", date: true },
      { header: "Budget", width: 15, example: 14200000, money: true },
      { header: "Spent", width: 15, example: 11050000, money: true },
      { header: "% Complete", width: 12, example: 0.72, percent: true },
      { header: "Open Question", width: 52, example: "Approve the 6-week re-baseline, or hold the date and de-scope segment 7?" },
      { header: "Last Updated", width: 14, example: new Date("2026-08-20"), date: true },
    ],
  },
  {
    name: "Milestones",
    note: "Optional. Joined to Projects by Project ID. Drives the timeline and the milestone counts in sections 1 and 4.",
    columns: [
      { header: "Project ID", width: 14, example: "PRJ-1001", required: true },
      { header: "Milestone", width: 40, example: "Federation gateway SIT entry", required: true },
      { header: "Due Date", width: 14, example: new Date("2026-09-15"), date: true },
      { header: "Completed Date", width: 16, example: new Date("2026-08-19"), date: true },
      { header: "Status", width: 14, example: "Completed", list: MILESTONE_STATUSES },
    ],
  },
  {
    name: "Updates",
    note: "Optional. Joined by Project ID. The newest update also sets Last Updated when that column is blank.",
    columns: [
      { header: "Project ID", width: 14, example: "PRJ-1001", required: true },
      { header: "Date", width: 13, example: new Date("2026-08-20"), date: true },
      { header: "Author", width: 20, example: "H. Al Mazrouei" },
      { header: "Update", width: 70, example: "SIT entry passed; vendor confirmed the revised integration plan.", required: true },
    ],
  },
  {
    name: "Risks",
    note: "Optional. Joined by Project ID. Open risks feed section 2 and the priority score; Closed risks are ignored.",
    columns: [
      { header: "Project ID", width: 14, example: "PRJ-1001", required: true },
      { header: "Risk", width: 50, example: "Federation gateway vendor cannot meet the SIT date", required: true },
      { header: "Severity", width: 12, example: "Critical", list: RISK_SEVERITIES },
      { header: "Status", width: 13, example: "Mitigating", list: RISK_STATUSES },
      { header: "Owner", width: 20, example: "S. Rahman" },
    ],
  },
  {
    name: "Questions",
    note: "Optional but valuable: these appear first in section 2, ahead of anything the system derives. Joined by Project ID.",
    columns: [
      { header: "Project ID", width: 14, example: "PRJ-1001", required: true },
      { header: "Question", width: 66, example: "Approve the 6-week re-baseline, or hold the September date and de-scope segment 7?", required: true },
      { header: "Asked By", width: 20, example: "S. Rahman" },
      { header: "Raised", width: 13, example: new Date("2026-08-20"), date: true },
      { header: "Needed By", width: 14, example: new Date("2026-08-29"), date: true },
      { header: "Decision Owner", width: 20, example: "CIO" },
      { header: "Status", width: 12, example: "Open", list: QUESTION_STATUSES },
    ],
  },
];

const READ_ME = [
  ["GCIO Project Intelligence — portfolio workbook", ""],
  ["", ""],
  ["How to use this file", "Delete the grey example row on each sheet, paste your data, save, and drop the file into the dashboard's data/ folder — or use Upload in the dashboard. Ingestion happens within about a second."],
  ["Required columns", "Only Project ID and Project Name. Every other column is optional; the briefing gets richer as you fill more in."],
  ["Sheet names", "Projects, Milestones, Updates, Risks, Questions. Matching is fuzzy — 'Project Risks' or 'Open Questions' work too. Extra sheets are ignored."],
  ["Column headers", "Matched intelligently. 'PM', 'Project Manager' and 'Owner' all map to Owner. 'RAG', 'Health Status' and 'Overall Health' all map to Health. Case, spaces and punctuation do not matter."],
  ["Dates", "ISO (2026-11-30), dd/mm/yyyy, or real Excel dates all work."],
  ["Money", "1200000, 'AED 1,200,000' and '1.2M' are all read as the same number."],
  ["Percent complete", "Either 0–1 (0.72) or 0–100 (72). Both are understood."],
  ["Health / RAG", "Green, Amber, Red — or On Track / At Risk / Off Track, or G / A / R."],
  ["Status", STATUSES.join(", ")],
  ["Priority", PRIORITIES.join(", ")],
  ["Phase", PHASES.join(", ")],
  ["Programs and sub-projects", "Set Parent Project ID on a child project to build the program → project chain shown in the drill-down."],
  ["Questions", "Anything written on the Questions sheet (or in the Projects sheet's 'Open Question' column) appears first in section 2, marked 'from PM'. Where a project has none, the dashboard derives questions from its state and marks them 'derived'."],
  ["Multiple files", "Split the portfolio across as many workbooks as you like — by department, by program, by owner. They are merged on Project ID. Deleting a file removes its projects."],
  ["Bad rows", "A malformed row is skipped and logged; it never stops the rest of the file from loading."],
];

/** Build the canonical template workbook. */
export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GCIO Project Intelligence";
  wb.created = new Date();

  /* ---- Read me ---- */
  const readme = wb.addWorksheet("Read me", { views: [{ showGridLines: false }] });
  readme.columns = [{ width: 30 }, { width: 118 }];
  READ_ME.forEach(([label, value], i) => {
    const row = readme.addRow([label, value]);
    row.alignment = { vertical: "top", wrapText: true };
    if (i === 0) {
      row.font = { bold: true, size: 16, color: { argb: NAVY } };
      row.height = 24;
    } else {
      row.getCell(1).font = { bold: true, size: 10, color: { argb: NAVY } };
      row.getCell(2).font = { size: 10, color: { argb: INK2 } };
      row.height = Math.max(16, Math.ceil(String(value).length / 105) * 14 + 4);
    }
  });

  /* ---- Data sheets ---- */
  for (const sheet of SHEETS) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 2 }] });

    const note = ws.addRow([sheet.note]);
    ws.mergeCells(1, 1, 1, sheet.columns.length);
    note.getCell(1).font = { italic: true, size: 9, color: { argb: INK2 } };
    note.getCell(1).alignment = { vertical: "middle" };
    note.height = 20;

    const header = ws.addRow(sheet.columns.map((c) => c.header));
    header.height = 20;
    header.eachCell((cell, i) => {
      const col = sheet.columns[i - 1];
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
      cell.font = { bold: true, size: 10, color: { argb: WHITE } };
      cell.alignment = { vertical: "middle" };
      cell.border = { bottom: { style: "thin", color: { argb: col.required ? LIME : GREEN } } };
      if (col.required) cell.note = "Required";
    });

    const example = ws.addRow(sheet.columns.map((c) => c.example ?? ""));
    example.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: WELL } };
      cell.font = { size: 10, color: { argb: INK2 }, italic: true };
      cell.alignment = { vertical: "top", wrapText: true };
    });

    sheet.columns.forEach((col, i) => {
      const column = ws.getColumn(i + 1);
      column.width = col.width;
      if (col.money) column.numFmt = '"AED" #,##0';
      if (col.percent) column.numFmt = "0%";
      if (col.date) column.numFmt = "dd mmm yyyy";

      /* Dropdowns down the usable range so pasted data still validates. */
      if (col.list) {
        for (let r = 3; r <= 500; r += 1) {
          ws.getCell(r, i + 1).dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: [`"${col.list.join(",")}"`],
            showErrorMessage: true,
            errorTitle: `${col.header} not recognised`,
            error: `Use one of: ${col.list.join(", ")}`,
          };
        }
      }
    });

    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: sheet.columns.length } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const TEMPLATE_FILENAME = "GCIO_Portfolio_Template.xlsx";
