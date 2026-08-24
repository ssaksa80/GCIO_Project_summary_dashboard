/**
 * Schema migrations.
 *
 * Mirrors DEDB's approach: numbered, idempotent statements applied at boot,
 * recorded in a table so a restart is a no-op. Each migration is written so
 * running it twice is harmless, because that is what actually happens when two
 * instances start together.
 */
import { sql } from "./executor.js";

/**
 * Ordered migrations. Never edit a shipped one — add the next number.
 * @type {{id: number, name: string, sql: string}[]}
 */
export const MIGRATIONS = [
  {
    id: 1,
    name: "audit_event",
    sql: `
      IF OBJECT_ID('dbo.AuditEvent', 'U') IS NULL
      CREATE TABLE dbo.AuditEvent (
        Id         BIGINT IDENTITY(1,1) PRIMARY KEY,
        At         DATETIME2(3)   NOT NULL,
        Actor      NVARCHAR(320)  NOT NULL,
        Action     NVARCHAR(80)   NOT NULL,
        Subject    NVARCHAR(600)  NULL,
        Ip         NVARCHAR(64)   NULL,
        UserAgent  NVARCHAR(400)  NULL,
        RequestId  NVARCHAR(64)   NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuditEvent_At')
        CREATE INDEX IX_AuditEvent_At ON dbo.AuditEvent (At DESC);
    `,
  },
  {
    id: 2,
    name: "posture_domain",
    sql: `
      IF OBJECT_ID('dbo.PostureDomain', 'U') IS NULL
      CREATE TABLE dbo.PostureDomain (
        Id                BIGINT IDENTITY(1,1) PRIMARY KEY,
        Domain            NVARCHAR(200)  NOT NULL,
        Control           NVARCHAR(300)  NULL,
        Status            NVARCHAR(40)   NOT NULL,
        Score             DECIMAL(5,2)   NOT NULL CONSTRAINT DF_PostureDomain_Score DEFAULT (0),
        Target            DECIMAL(5,2)   NOT NULL CONSTRAINT DF_PostureDomain_Target DEFAULT (100),
        Owner             NVARCHAR(200)  NULL,
        LastAssessed      DATE           NULL,
        NextReview        DATE           NULL,
        OpenFindings      INT            NOT NULL CONSTRAINT DF_PostureDomain_Open DEFAULT (0),
        CriticalFindings  INT            NOT NULL CONSTRAINT DF_PostureDomain_Crit DEFAULT (0),
        ProjectId         NVARCHAR(60)   NULL,
        Notes             NVARCHAR(MAX)  NULL,
        SourceFile        NVARCHAR(260)  NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PostureDomain_SourceFile')
        CREATE INDEX IX_PostureDomain_SourceFile ON dbo.PostureDomain (SourceFile);
    `,
  },
];

const LEDGER = `
  IF OBJECT_ID('dbo.SchemaMigration', 'U') IS NULL
  CREATE TABLE dbo.SchemaMigration (
    Id       INT           NOT NULL PRIMARY KEY,
    Name     NVARCHAR(120) NOT NULL,
    AppliedAt DATETIME2(3) NOT NULL
  );
`;

/**
 * Apply every migration not yet recorded.
 * @param {{query: Function, tx: Function}} ex
 * @returns {Promise<{applied: number[], alreadyCurrent: boolean}>}
 */
export async function migrate(ex, { logger = console } = {}) {
  await ex.query(LEDGER);
  const { recordset } = await ex.query("SELECT Id FROM dbo.SchemaMigration");
  const done = new Set(recordset.map((r) => r.Id));

  const applied = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    logger.info?.(`[db] applying migration ${migration.id} — ${migration.name}`);
    await ex.query(migration.sql);
    await ex.query(
      "INSERT INTO dbo.SchemaMigration (Id, Name, AppliedAt) VALUES (@id, @name, SYSUTCDATETIME())",
      [
        { name: "id", type: sql.Int, value: migration.id },
        { name: "name", type: sql.NVarChar(120), value: migration.name },
      ]
    );
    applied.push(migration.id);
  }
  return { applied, alreadyCurrent: applied.length === 0 };
}
