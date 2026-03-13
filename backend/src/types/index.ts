import { Kysely } from "kysely";

export type File = {
  path: string;
  relativePath: string;
  isDirectory: boolean;
  depth: number;
};

export interface EmbeddingTable {
  id: string;
  content: string;
  embedding: string;
  metadata: Record<string, any>;
  created_at: Date;
}

export interface Database {
  embeddings: EmbeddingTable;
}

export type DBClient = Kysely<Database>;
