// Cloudflare Worker entry. The build inlines the client bundle, stylesheet
// and HTML into this module, producing one deployable file: dist/worker.js.

import { createApp } from './server/app.js';
import assets from 'virtual:assets';

const app = createApp({ assets });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};
