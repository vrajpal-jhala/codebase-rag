import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
  knowledgeBasePath: resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../.data/repositories',
  ),
  db: {
    user: 'postgres',
    password: 'postgres',
    host: 'localhost',
    name: 'codebase-rag',
    port: 5432,
    connectionMaxPoolSize: 15,
    poolConnectionIdleTimeout: 900000,
    maxRetryAttemptsForTransaction: 5,
  },
  embeddings: {
    model: 'nomic-embed-text',
    baseUrl: 'http://10.40.0.20:11434',
  }
};
