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
  {
    id: 3,
    name: "sessions",
    sql: `
      IF OBJECT_ID('dbo.Sessions', 'U') IS NULL
      CREATE TABLE dbo.Sessions (
        SessionId    UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        Principal    NVARCHAR(200)  NOT NULL,
        DisplayName  NVARCHAR(200)  NULL,
        Role         VARCHAR(10)    NOT NULL,
        Groups       NVARCHAR(MAX)  NULL,
        ExpiresAt    DATETIME2(0)   NOT NULL,
        LastSeenAt   DATETIME2(0)   NOT NULL,
        LastIp       VARCHAR(45)    NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Sessions_ExpiresAt')
        CREATE INDEX IX_Sessions_ExpiresAt ON dbo.Sessions (ExpiresAt);
    `,
  },
  {
    id: 4,
    name: "role_mapping",
    sql: `
      IF OBJECT_ID('dbo.RoleMapping', 'U') IS NULL
      CREATE TABLE dbo.RoleMapping (
        GroupName NVARCHAR(300) NOT NULL PRIMARY KEY,
        Role      VARCHAR(10)   NOT NULL
      );
    `,
  },
  {
    id: 5,
    name: "portfolio",
    sql: `
      IF OBJECT_ID('dbo.Project', 'U') IS NULL
      CREATE TABLE dbo.Project (
        ProjectId       NVARCHAR(60)   NOT NULL PRIMARY KEY,
        Name            NVARCHAR(400)  NOT NULL,
        Description     NVARCHAR(MAX)  NULL,
        Department      NVARCHAR(200)  NULL,
        Pillar          NVARCHAR(200)  NULL,
        Program         NVARCHAR(200)  NULL,
        ParentId        NVARCHAR(60)   NULL,
        Owner           NVARCHAR(200)  NULL,
        Sponsor         NVARCHAR(200)  NULL,
        Vendor          NVARCHAR(200)  NULL,
        Status          NVARCHAR(40)   NOT NULL,
        Health          NVARCHAR(20)   NOT NULL,
        Priority        NVARCHAR(20)   NOT NULL,
        Phase           NVARCHAR(40)   NULL,
        ApprovalDate    DATE           NULL,
        StartDate       DATE           NULL,
        TargetEndDate   DATE           NULL,
        ActualEndDate   DATE           NULL,
        Budget          DECIMAL(19,2)  NOT NULL CONSTRAINT DF_Project_Budget DEFAULT (0),
        Spent           DECIMAL(19,2)  NOT NULL CONSTRAINT DF_Project_Spent DEFAULT (0),
        PercentComplete DECIMAL(5,2)   NOT NULL CONSTRAINT DF_Project_Pct DEFAULT (0),
        Currency        NVARCHAR(10)   NOT NULL CONSTRAINT DF_Project_Ccy DEFAULT ('AED'),
        LastUpdated     DATE           NULL,
        SourceFile      NVARCHAR(260)  NOT NULL,
        IngestedAt      DATETIME2(3)   NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Project_SourceFile')
        CREATE INDEX IX_Project_SourceFile ON dbo.Project (SourceFile);

      IF OBJECT_ID('dbo.ProjectChild', 'U') IS NULL
      CREATE TABLE dbo.ProjectChild (
        Id         BIGINT IDENTITY(1,1) PRIMARY KEY,
        ProjectId  NVARCHAR(60)  NOT NULL,
        Kind       VARCHAR(12)   NOT NULL,
        Payload    NVARCHAR(MAX) NOT NULL,
        SourceFile NVARCHAR(260) NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectChild_Project')
        CREATE INDEX IX_ProjectChild_Project ON dbo.ProjectChild (ProjectId, Kind);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectChild_SourceFile')
        CREATE INDEX IX_ProjectChild_SourceFile ON dbo.ProjectChild (SourceFile);
    `,
  },
  {
    id: 6,
    name: "source_files_and_runs",
    sql: `
      IF OBJECT_ID('dbo.SourceFile', 'U') IS NULL
      CREATE TABLE dbo.SourceFile (
        SourceFileId  BIGINT IDENTITY(1,1) PRIMARY KEY,
        FileName      NVARCHAR(260)  NOT NULL,
        Sha256        CHAR(64)       NOT NULL,
        Bytes         BIGINT         NOT NULL,
        VaultPath     NVARCHAR(400)  NULL,
        UploadedBy    NVARCHAR(320)  NULL,
        FirstSeenAt   DATETIME2(3)   NOT NULL,
        LastSeenAt    DATETIME2(3)   NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_SourceFile_Name_Sha')
        CREATE UNIQUE INDEX UX_SourceFile_Name_Sha ON dbo.SourceFile (FileName, Sha256);

      IF OBJECT_ID('dbo.IngestRun', 'U') IS NULL
      CREATE TABLE dbo.IngestRun (
        IngestRunId     BIGINT IDENTITY(1,1) PRIMARY KEY,
        SourceFileId    BIGINT         NULL,
        FileName        NVARCHAR(260)  NOT NULL,
        TriggerSource   VARCHAR(16)    NOT NULL,   -- TRIGGER is a reserved word
        StartedAt       DATETIME2(3)   NOT NULL,
        FinishedAt      DATETIME2(3)   NULL,
        Outcome         VARCHAR(16)    NULL,
        ProjectsSeen    INT            NOT NULL CONSTRAINT DF_IngestRun_Seen DEFAULT (0),
        ProjectsChanged INT            NOT NULL CONSTRAINT DF_IngestRun_Changed DEFAULT (0),
        PostureRows     INT            NOT NULL CONSTRAINT DF_IngestRun_Posture DEFAULT (0),
        Error           NVARCHAR(1000) NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_IngestRun_StartedAt')
        CREATE INDEX IX_IngestRun_StartedAt ON dbo.IngestRun (StartedAt DESC);
    `,
  },
  {
    id: 7,
    name: "project_version",
    sql: `
      IF OBJECT_ID('dbo.ProjectVersion', 'U') IS NULL
      CREATE TABLE dbo.ProjectVersion (
        ProjectVersionId BIGINT IDENTITY(1,1) PRIMARY KEY,
        ProjectId        NVARCHAR(60)   NOT NULL,
        ContentHash      CHAR(64)       NOT NULL,
        IngestRunId      BIGINT         NULL,
        RecordedAt       DATETIME2(3)   NOT NULL,
        Name             NVARCHAR(400)  NOT NULL,
        Department       NVARCHAR(200)  NULL,
        Status           NVARCHAR(40)   NOT NULL,
        Health           NVARCHAR(20)   NOT NULL,
        Priority         NVARCHAR(20)   NOT NULL,
        Phase            NVARCHAR(40)   NULL,
        Owner            NVARCHAR(200)  NULL,
        TargetEndDate    DATE           NULL,
        ActualEndDate    DATE           NULL,
        Budget           DECIMAL(19,2)  NOT NULL CONSTRAINT DF_ProjectVersion_Budget DEFAULT (0),
        Spent            DECIMAL(19,2)  NOT NULL CONSTRAINT DF_ProjectVersion_Spent DEFAULT (0),
        PercentComplete  DECIMAL(5,2)   NOT NULL CONSTRAINT DF_ProjectVersion_Pct DEFAULT (0),
        OpenRisks        INT            NOT NULL CONSTRAINT DF_ProjectVersion_Risks DEFAULT (0),
        OpenQuestions    INT            NOT NULL CONSTRAINT DF_ProjectVersion_Questions DEFAULT (0),
        Payload          NVARCHAR(MAX)  NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectVersion_Project')
        CREATE INDEX IX_ProjectVersion_Project ON dbo.ProjectVersion (ProjectId, RecordedAt DESC);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectVersion_RecordedAt')
        CREATE INDEX IX_ProjectVersion_RecordedAt ON dbo.ProjectVersion (RecordedAt DESC);
    `,
  },
  {
    id: 8,
    name: "history_constraints",
    sql: `
      /* The ingest hot path reads (ProjectId, ContentHash) for every changed
         project on every ingest. Without ContentHash in the index each row
         costs a key lookup, and that cost grows with the history.

         This is written as a single atomic CREATE ... WITH (DROP_EXISTING = ON)
         rather than a separate IF EXISTS DROP / IF NOT EXISTS CREATE pair.
         The separate-statement version was tried first and failed a forced
         concurrency test: with two boots racing, session A can evaluate its
         "IF EXISTS" as true, stall, and by the time its DROP INDEX actually
         runs, session B has already dropped and recreated the same-named
         index — so A's DROP removes B's brand-new index and nothing ever
         recreates it, leaving the table with no index of that name at all.
         DROP_EXISTING replaces the index in one statement with no gap
         between the check and the act, so there is no window in which the
         index can be observed missing, whichever branch a racing session
         takes. */
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectVersion_Project')
        CREATE INDEX IX_ProjectVersion_Project ON dbo.ProjectVersion (ProjectId, RecordedAt DESC)
          INCLUDE (ContentHash) WITH (DROP_EXISTING = ON);
      ELSE
        CREATE INDEX IX_ProjectVersion_Project ON dbo.ProjectVersion (ProjectId, RecordedAt DESC)
          INCLUDE (ContentHash);

      /* Nothing ever deletes a SourceFile or an IngestRun, so these two can be
         enforced. ProjectVersion.ProjectId deliberately has NO key to
         dbo.Project: replaceForFile deletes and reinserts every project row on
         each ingest, so a constraint there would destroy the history it is
         supposed to protect. */
      IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_IngestRun_SourceFile')
        ALTER TABLE dbo.IngestRun WITH CHECK
          ADD CONSTRAINT FK_IngestRun_SourceFile FOREIGN KEY (SourceFileId)
          REFERENCES dbo.SourceFile (SourceFileId);

      IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ProjectVersion_IngestRun')
        ALTER TABLE dbo.ProjectVersion WITH CHECK
          ADD CONSTRAINT FK_ProjectVersion_IngestRun FOREIGN KEY (IngestRunId)
          REFERENCES dbo.IngestRun (IngestRunId);

      /* Both columns are written from a fixed vocabulary in JavaScript. A typo
         or an undocumented fifth value would quietly corrupt every Phase 2
         aggregate that counts runs by outcome. */
      IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IngestRun_TriggerSource')
        ALTER TABLE dbo.IngestRun WITH CHECK
          ADD CONSTRAINT CK_IngestRun_TriggerSource
          CHECK (TriggerSource IN ('watcher', 'upload', 'boot', 'replay'));

      IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IngestRun_Outcome')
        ALTER TABLE dbo.IngestRun WITH CHECK
          ADD CONSTRAINT CK_IngestRun_Outcome
          CHECK (Outcome IS NULL OR Outcome IN ('applied', 'unchanged', 'failed', 'removed'));
    `,
  },
  {
    id: 9,
    name: "cover_changed_since",
    sql: `
      /* changedSince ranks every version of every project on each request, and
         selects eight columns beyond the key. Without them in the index the
         optimiser goes to the clustered index -- dragging the ~1.8 kB in-row
         Payload along on every page -- and then has to sort, because clustered
         order is by identity, not by (ProjectId, RecordedAt DESC).

         DROP_EXISTING replaces the index atomically. A guarded DROP followed by
         a guarded CREATE lets a second booting instance drop what the first has
         just built, leaving the table with no index of that name and no error
         anywhere -- see migration 8. */
      CREATE INDEX IX_ProjectVersion_Project ON dbo.ProjectVersion (ProjectId, RecordedAt DESC)
        INCLUDE (ContentHash, Status, Health, PercentComplete, Budget, Spent,
                 OpenRisks, OpenQuestions, TargetEndDate)
        WITH (DROP_EXISTING = ON);
    `,
  },
  {
    id: 10,
    name: "ingest_durations",
    sql: `
      /* Worker-thread parsing was deferred on the grounds that the workbooks
         are tiny. That is a measurement, and measurements expire — so record
         the measurement rather than the conclusion. When ParseMs starts
         climbing, the deferral stops being justified. */
      IF COL_LENGTH('dbo.IngestRun', 'ParseMs') IS NULL
        ALTER TABLE dbo.IngestRun ADD ParseMs INT NULL;
      IF COL_LENGTH('dbo.IngestRun', 'PersistMs') IS NULL
        ALTER TABLE dbo.IngestRun ADD PersistMs INT NULL;
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
