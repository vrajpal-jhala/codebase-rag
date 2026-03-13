import PostgresDB from './pg-db';
import { indexing } from '../components/indexing';

export const services = {
  init: async () => {
    PostgresDB.init();
    await indexing.init();
  },
};
