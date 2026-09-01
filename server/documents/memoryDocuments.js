/**
 * Documents without a database.
 *
 * STORE=memory has no repos, and the hermetic suite runs on it. Without this,
 * the whole document path could only be exercised against SQL, which the test
 * suite deliberately does not touch. Same interface as documentExtracts.js so
 * nothing above either of them knows which one it has.
 */
export function memoryDocuments() {
  const bySourceFileId = new Map();

  return {
    /* Newest first, matching documentExtractsRepo.list's
       `ORDER BY ExtractedAt DESC, DocumentExtractId DESC`. A Map iterates in
       insertion order, so reversing it is that ordering exactly: extractedAt
       is stamped on insert, and reverse-insertion is the same tiebreak the
       descending identity column gives SQL when two extracts land inside the
       same millisecond. Without this the Documents section would be ordered
       one way on STORE=memory and the other way on STORE=mssql, and only the
       store the tests never run would be right. */
    async list() {
      return [...bySourceFileId.values()].reverse();
    },

    async add(doc) {
      /* First write wins: re-importing identical bytes is the same document,
         and restamping it would make an unchanged file look freshly imported.
         This is UX_DocumentExtract_SourceFile's job in SQL. */
      const existing = bySourceFileId.get(doc.sourceFileId);
      if (existing) return existing;

      /* Spread, so pageCount arrives exactly as the extractor produced it --
         null for .docx and .txt, which have no pages before they are
         rendered. Coercing that to 0 would report a page count that is a lie
         rather than a gap. */
      const stored = { ...doc, extractedAt: new Date().toISOString() };
      bySourceFileId.set(doc.sourceFileId, stored);
      return stored;
    },

    async remove(sourceFileId) {
      return bySourceFileId.delete(sourceFileId);
    },
  };
}

/**
 * The vault ledger without a database, matching sourceFilesRepo.record.
 *
 * Idempotent on (fileName, sha256) exactly as UX_SourceFile_Name_Sha makes the
 * SQL one -- re-importing identical bytes must return the same id, or the
 * document store would be handed a new key each time and keep duplicating a
 * file that has not changed.
 */
export function memorySourceFiles() {
  const idsByKey = new Map();
  let nextId = 1;

  return {
    async record({ fileName, sha256 }) {
      /* Both halves of the key, because UX_SourceFile_Name_Sha is on
         (FileName, Sha256): the same bytes filed under a different name are a
         different row there, and this must not collapse them into one. */
      const key = `${fileName} ${sha256}`;
      const existing = idsByKey.get(key);
      if (existing) return { sourceFileId: existing, alreadySeen: true };

      const sourceFileId = nextId++;
      idsByKey.set(key, sourceFileId);
      return { sourceFileId, alreadySeen: false };
    },
  };
}
