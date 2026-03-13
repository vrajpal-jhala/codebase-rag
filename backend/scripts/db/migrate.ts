import { Kysely, Migrator, FileMigrationProvider, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import type { Database } from '../../src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbConfig = {
  user: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  ssl: false,
};

const pool = new Pool(dbConfig);

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

async function createDatabaseIfNotExists() {
  try {
    await sql`CREATE DATABASE ${sql.ref('codebase_rag')}`.execute(db);
    console.log(`Database codebase_rag created successfully`);
  } catch (error: any) {
    if (error.code === '42P04') {
      console.log(`Database codebase_rag already exists`);
    } else {
      throw error;
    }
  } finally {
    await db.destroy();
  }
}

async function migrateToLatest() {
  await createDatabaseIfNotExists();

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('failed to migrate');
    console.error(error);
    process.exit(1);
  }

  await db.destroy();
}

migrateToLatest();
