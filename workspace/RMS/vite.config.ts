import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { handleLocalApiRoute } from './server/localApi';

function localApiPlugin(): Plugin {
  return {
    name: 'local-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const handled = await handleLocalApiRoute(req, res);
        if (!handled) next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const handled = await handleLocalApiRoute(req, res);
        if (!handled) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApiPlugin()],
});
