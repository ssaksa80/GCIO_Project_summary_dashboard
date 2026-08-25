/**
 * Every workbook the dashboard has ever ingested, identified by content hash.
 *
 * A file re-saved with no changes has the same hash, which is what lets the
 * ingester skip work instead of rewriting the portfolio for nothing.
 */
import { sql } from "../db/executor.js";

export function sourceFilesRepo(ex) {
  return {
    /**
     * Record that this exact file was seen. Idempotent on (name, hash).
     * @param {{fileName: string, sha256: string, bytes: number, vaultPath?: string, uploadedBy?: string}} file
     * @returns {Promise<{sourceFileId: number, alreadySeen: boolean}>}
     */
    async record({ fileName, sha256, bytes, vaultPath = null, uploadedBy = null }) {
      const existing = await ex.query(`
        SELECT SourceFileId FROM dbo.SourceFile WHERE FileName = @name AND Sha256 = @sha
      `, [
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "sha", type: sql.Char(64), value: sha256 },
      ]);

      if (existing.recordset.length) {
        await ex.query("UPDATE dbo.SourceFile SET LastSeenAt = SYSUTCDATETIME() WHERE SourceFileId = @id", [
          { name: "id", type: sql.BigInt, value: existing.recordset[0].SourceFileId },
        ]);
        return { sourceFileId: Number(existing.recordset[0].SourceFileId), alreadySeen: true };
      }

      const inserted = await ex.query(`
        INSERT INTO dbo.SourceFile (FileName, Sha256, Bytes, VaultPath, UploadedBy, FirstSeenAt, LastSeenAt)
        OUTPUT INSERTED.SourceFileId
        VALUES (@name, @sha, @bytes, @vault, @by, SYSUTCDATETIME(), SYSUTCDATETIME())
      `, [
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "sha", type: sql.Char(64), value: sha256 },
        { name: "bytes", type: sql.BigInt, value: Number(bytes) || 0 },
        { name: "vault", type: sql.NVarChar(400), value: vaultPath },
        { name: "by", type: sql.NVarChar(320), value: uploadedBy },
      ]);
      return { sourceFileId: Number(inserted.recordset[0].SourceFileId), alreadySeen: false };
    },

    /** The hash of the most recent version of a named file, or null. */
    async newestHashFor(fileName) {
      const { recordset } = await ex.query(`
        SELECT TOP (1) Sha256 FROM dbo.SourceFile WHERE FileName = @name ORDER BY LastSeenAt DESC
      `, [{ name: "name", type: sql.NVarChar(260), value: fileName }]);
      return recordset.length ? recordset[0].Sha256 : null;
    },
  };
}
