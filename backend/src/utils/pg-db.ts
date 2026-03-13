import { Kysely, PostgresDialect } from 'kysely';
import { Pool, PoolConfig } from 'pg';
import { type Database, type DBClient } from '../types';
import { config } from './config';

class PostgresDB {
  private static dbClient: DBClient;

  static getPoolConfig(): PoolConfig {
    return {
      user: config.db.user,
      password: config.db.password,
      host: config.db.host,
      database: config.db.name,
      port: config.db.port,
      max: config.db.connectionMaxPoolSize,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: config.db.poolConnectionIdleTimeout,
      statement_timeout: 30000,
      query_timeout: 30000,
      ssl: false,
    };
  }

  static init() {
    if (!PostgresDB.dbClient) {
      const pool = new Pool(PostgresDB.getPoolConfig());

      PostgresDB.dbClient = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool,
        }),
      });
    }
  }

  static get client() {
    return PostgresDB.dbClient;
  }

  static async transaction<T>(
    callback: (trx: DBClient) => Promise<T>,
    stackTrace: string | undefined
  ): Promise<T> {
    let retryAttempt = 0;

    while (true) {
      try {
        return await PostgresDB.dbClient.transaction().execute(callback);
      } catch (error: any) {
        retryAttempt += 1;

        if (
          error.code === '40001' &&
          retryAttempt < config.db.maxRetryAttemptsForTransaction
        ) {
          console.warn(
            `RetryAttempt: ${retryAttempt}, StackTrace: ${
              stackTrace || '-'
            }, Error: ${error}`
          );

          continue;
        }

        error.data = { stackTrace };
        throw error;
      }
    }
  }

  static async execute<T>(
    op: (dbClient: DBClient) => Promise<T>,
    stackTrace: string | undefined
  ): Promise<T> {
    try {
      return await op(PostgresDB.dbClient);
    } catch (error: any) {
      error.data = { stackTrace };
      throw error;
    }
  }

  static async *executeGenerator<T, TOutput>(
    op: (dbClient: DBClient) => AsyncGenerator<T, TOutput, unknown>,
    stackTrace: string | undefined
  ): AsyncGenerator<T, TOutput, unknown> {
    try {
      return yield* op(PostgresDB.dbClient);
    } catch (error: any) {
      error.data = { stackTrace };
      throw error;
    }
  }
}

export default PostgresDB;
