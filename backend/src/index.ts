import { Elysia } from 'elysia';
import { services } from './utils/services';
// @ts-ignore
import pkg from '../package.json';

const app = new Elysia().get('/', () => 'Hello Elysia').listen(3000);

await services.init();

console.log(
  `🦊 ${pkg.name} is running at ${app.server?.hostname}:${app.server?.port}`,
);
