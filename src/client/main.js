// Browser entry point.

import { defineRoutes, startRouter } from './router.js';
import { store } from './store.js';
import { applyTheme } from './dialogs.js';
import { homeView } from './views/home.js';
import { playView } from './views/play.js';
import { archiveView } from './views/archive.js';

applyTheme(store.settings().theme);

defineRoutes([
  ['/', homeView],
  ['/play/:date/:level', (p) => playView(p, 'daily')],
  ['/practice/:level', (p) => playView(p, 'practice')],
  ['/archive', archiveView],
  ['/archive/:month', archiveView],
]);

startRouter();
