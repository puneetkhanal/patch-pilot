import express from 'express';
import path from 'node:path';
import { apiRouter, ApiDependencies } from './api/routes.js';

export function createApp(dependencies: ApiDependencies, staticRoot = path.resolve('public')) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter(dependencies));
  app.use(express.static(staticRoot));
  app.use((error: any, _req: any, res: any, _next: any) => {
    console.error(error);
    const status = error?.status || (error?.name === 'ZodError' ? 400 : 500);
    res.status(status).json({ error: error?.message || 'Internal error' });
  });
  return app;
}
