/**
 * dbo.DocumentExtract -- what was read out of each imported document.
 *
 * The extract is stored as one JSON document rather than normalised. See the
 * comment on migration 12 for why: nothing queries across documents by block
 * or fact, so normalising would cost a migration per shape change and buy
 * nothing.
 */
import { sql } from "../db/executor.js";

const SELECT_COLUMNS = `
        SELECT d.SourceFileId, s.FileName, d.Kind, d.Title,
               d.PageCount, d.WordCount, d.ExtractJson, d.ExtractedAt
          FROM dbo.DocumentExtract d
          JOIN dbo.SourceFile s ON s.SourceFileId = d.SourceFileId`;

const toStored = (row) => ({
  sourceFileId: Number(row.SourceFileId),
  fileName: row.FileName,
  kind: row.Kind,
  title: row.Title,
  /* Not `|| null` and not Number(): NULL means .docx or .txt, which have no
     pages, and Number(null) is 0 -- a page count that is a lie rather than a
     gap. A genuine 0 cannot be written, so only NULL takes this branch. */
  pageCount: row.PageCount === null || row.PageCount === undefined ? null : Number(row.PageCount),
  wordCount: Number(row.WordCount),
  extract: JSON.parse(row.ExtractJson),
  extractedAt: new Date(row.ExtractedAt).toISOString(),
});

export function documentExtractsRepo(ex) {
  return {
    /** @returns {Promise<object[]>} every stored extract, newest first */
    async list() {
      const { recordset } = await ex.query(`${SELECT_COLUMNS}
         ORDER BY d.ExtractedAt DESC, d.DocumentExtractId DESC;
      `, []);
      return recordset.map(toStored);
    },

    /**
     * Insert unless this source file already has an extract.
     * @returns {Promise<object>} the stored row, new or pre-existing
     */
    async add(doc) {
      /* WHERE NOT EXISTS rather than MERGE: there is exactly one conflict to
         handle and it always resolves the same way -- keep what is there. A
         re-import of identical bytes must not restamp ExtractedAt, or an
         unchanged document looks freshly imported every time it is uploaded. */
      await ex.query(`
        INSERT INTO dbo.DocumentExtract
          (SourceFileId, Kind, Title, PageCount, WordCount, ExtractJson, ExtractedAt)
        SELECT @id, @kind, @title, @pages, @words, @json, SYSUTCDATETIME()
         WHERE NOT EXISTS (
           SELECT 1 FROM dbo.DocumentExtract WITH (HOLDLOCK)
            WHERE SourceFileId = @id
         );
      `, [
        { name: "id", type: sql.BigInt, value: doc.sourceFileId },
        { name: "kind", type: sql.VarChar(8), value: doc.kind },
        { name: "title", type: sql.NVarChar(400), value: doc.title },
        /* ?? null, not || null: a document really can have no pages, and an
           undefined here would bind as a missing parameter rather than NULL. */
        { name: "pages", type: sql.Int, value: doc.pageCount ?? null },
        { name: "words", type: sql.Int, value: doc.wordCount },
        { name: "json", type: sql.NVarChar(sql.MAX), value: JSON.stringify(doc.extract) },
      ]);

      const { recordset } = await ex.query(`${SELECT_COLUMNS}
         WHERE d.SourceFileId = @id;
      `, [{ name: "id", type: sql.BigInt, value: doc.sourceFileId }]);

      return toStored(recordset[0]);
    },

    /** @returns {Promise<boolean>} whether a row was actually removed */
    async remove(sourceFileId) {
      const { rowsAffected } = await ex.query(
        `DELETE FROM dbo.DocumentExtract WHERE SourceFileId = @id;`,
        [{ name: "id", type: sql.BigInt, value: sourceFileId }]
      );
      return (rowsAffected?.[0] ?? 0) > 0;
    },
  };
}
