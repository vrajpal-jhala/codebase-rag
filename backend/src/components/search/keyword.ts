import PostgresDB from '../../utils/pg-db';
import { sql } from 'kysely';

export const keywordSearch = async (query: string, topK: number = 10) => {
  const results = await PostgresDB.execute(async (dbClient) => {
    return await dbClient
      .selectFrom('embeddings')
      .select([
        'id',
        'content',
        sql<number>`ts_rank_cd(fts, websearch_to_tsquery('${query}'))`.as('score'),
      ])
      .where(sql<boolean>`fts @@ websearch_to_tsquery('${query}')`)
      .orderBy('score', 'desc')
      .limit(topK)
      .execute();
  }, new Error().stack);

  return results;
};
