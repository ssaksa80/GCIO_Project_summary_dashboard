/**
 * Every workbook the dashboard has ever ingested, identified by content hash.
 *
 * This is the vault ledger, nothing more: recording that these bytes were
 * seen and vaulted is correct unconditionally, whether or not the ingest that
 * followed actually succeeded. Deciding whether a file's content is what the
 * dashboard is currently showing is a different question — "seen" is not
 * "live" — and that decision belongs to IngestRun.liveHashFor, which looks at
 * whether the ingest actually landed, not just whether the bytes matched.
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
      /* One statement, not SELECT-then-branch. UX_SourceFile_Name_Sha makes the
         racy version fail with a duplicate key when two watcher events for the
         same file are in flight at once, which chokidar permits. HOLDLOCK takes
         the range lock that makes the second caller wait and then see the row. */
      const { recordset } = await ex.query(`
        MERGE dbo.SourceFile WITH (HOLDLOCK) AS target
        USING (VALUES (@name, @sha)) AS incoming (FileName, Sha256)
           ON target.FileName = incoming.FileName AND target.Sha256 = incoming.Sha256
        WHEN MATCHED THEN
          UPDATE SET LastSeenAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (FileName, Sha256, Bytes, VaultPath, UploadedBy, FirstSeenAt, LastSeenAt)
          VALUES (@name, @sha, @bytes, @vault, @by, SYSUTCDATETIME(), SYSUTCDATETIME())
        OUTPUT $action AS Action, INSERTED.SourceFileId;
      `, [
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "sha", type: sql.Char(64), value: sha256 },
        { name: "bytes", type: sql.BigInt, value: Number(bytes) || 0 },
        { name: "vault", type: sql.NVarChar(400), value: vaultPath },
        { name: "by", type: sql.NVarChar(320), value: uploadedBy },
      ]);

      const row = recordset[0];
      return { sourceFileId: Number(row.SourceFileId), alreadySeen: row.Action === "UPDATE" };
    },
  };
}
