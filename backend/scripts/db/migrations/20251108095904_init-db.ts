import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Enable pgvector extension
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  // Create embeddings table for vector storage
  await db.schema
    .createTable('embeddings')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('vector', sql`vector(768)`, (col) => col.notNull()) // * update column size whenever changing embedding model
    .addColumn('metadata', 'jsonb', (col) => col.notNull())
    .addColumn('fts', sql`tsvector`, (col) =>
      col.generatedAlwaysAs(sql`to_tsvector('english', content)`).stored(),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .execute();

  // Create vector similarity index using HNSW (Hierarchical Navigable Small World) algorithm
  // This provides fast approximate nearest neighbor search
  await sql`CREATE INDEX embeddings_vector_idx ON embeddings USING hnsw (vector vector_cosine_ops)`.execute(db);

  // Create GIN index on the fts column
  await db.schema
    .createIndex('embeddings_fts_gin_index')
    .on('embeddings')
    .using('gin')
    .on('fts')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS vector`.execute(db);
  await db.schema.dropTable('embeddings').execute();
}
