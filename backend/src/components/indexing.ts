import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from '../utils/config';
import { walk } from '../utils/helpers';
import PostgresDB from '../utils/pg-db';
import { TREE_SITTER_PARSERS } from '../utils/constants';

export const indexing = {
  init: async () => {
    const embeddings = new OllamaEmbeddings({
      baseUrl: config.embeddings.baseUrl,
      model: config.embeddings.model,
    });
    const vectorStore = await PGVectorStore.initialize(embeddings, {
      postgresConnectionOptions: PostgresDB.getPoolConfig(),
      tableName: 'embeddings',
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'vector',
        contentColumnName: 'content',
        metadataColumnName: 'metadata',
      },
    });
    const files = await walk(config.knowledgeBasePath);
    console.log(Object.keys(TREE_SITTER_PARSERS));

    for (const file of files) {
      const content = await Bun.file(file.path).text();
      // const vector = await embeddings.embedQuery(content);
    }
  },
};
