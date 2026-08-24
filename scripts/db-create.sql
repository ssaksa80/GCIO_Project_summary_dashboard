/*
  Creates the GCIO database and the application login.

  Run once, as a SQL sysadmin (sa, or an account in the sysadmin role):

      sqlcmd -S "localhost\SQLEXPRESS" -U sa -C -i scripts/db-create.sql

  Or open it in SSMS with an administrator connection and execute.

  Before running: replace CHANGE_THIS_PASSWORD below, then put the same value
  in .env as DB_PASSWORD. Do not commit .env — it is git-ignored.

  The application itself never needs these rights: it only reads and writes
  its own tables. Schema changes are applied by the migration runner at boot,
  which is why the login is db_owner inside GCIO and nothing outside it.
*/

IF DB_ID('GCIO') IS NULL
    CREATE DATABASE GCIO;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'gcio_app')
    CREATE LOGIN gcio_app WITH PASSWORD = 'CHANGE_THIS_PASSWORD', CHECK_POLICY = ON;
GO

USE GCIO;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'gcio_app')
    CREATE USER gcio_app FOR LOGIN gcio_app;
GO

ALTER ROLE db_owner ADD MEMBER gcio_app;
GO

PRINT 'GCIO database and gcio_app login are ready.';
GO

/*
  Windows Integrated auth instead of a SQL login
  ----------------------------------------------
  Preferred in production: the service runs as a domain account and no password
  is stored anywhere. Create the login for that account instead of gcio_app:

      CREATE LOGIN [DOMAIN\svc-gcio] FROM WINDOWS;
      USE GCIO;
      CREATE USER [DOMAIN\svc-gcio] FOR LOGIN [DOMAIN\svc-gcio];
      ALTER ROLE db_owner ADD MEMBER [DOMAIN\svc-gcio];

  Note that the node `mssql` driver's default transport (tedious) does not
  implement Windows Integrated authentication from a plain
  `trustedConnection: true` flag — see the note in server/db/pool.js.
*/
