/**
 * The first parse in a process runs cold: nothing has JIT-compiled or paged
 * in the XLSX parsing code yet. Measured on a live deployment: 1903ms for the
 * first parse after a restart vs 128ms for the identical workbook parsed
 * later in the same process (a watcher-triggered re-ingest) -- about 15x.
 *
 * That is not the same thing as a slow parse, so ingestBuffer() marks it
 * rather than leaving the caller to guess from TriggerSource -- which is not
 * a reliable proxy: the boot sweep usually runs first, but an empty drop
 * folder at boot means the first real parse arrives from a watcher event
 * instead, and TriggerSource would call that "watcher" exactly like every
 * later one. See ingestRuns.js for how the flag changes what "slow" means.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ingestBuffer } from "../../server/ingest.js";

const workbook = fs.readFileSync("sample-data/GCIO_Portfolio_Master.xlsx");

test("the first parse in this process is flagged cold-start; the second is not", () => {
  const first = ingestBuffer(workbook, "first.xlsx");
  const second = ingestBuffer(workbook, "second.xlsx");

  assert.equal(first.ok, true, "fixture workbook failed to parse");
  assert.equal(second.ok, true, "fixture workbook failed to parse");
  assert.equal(first.coldStart, true, "the first parse in the process was not flagged cold-start");
  assert.equal(second.coldStart, false, "a later parse in the same process was flagged cold-start");
});
