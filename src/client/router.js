// History-API router. Routes are [pattern, view] pairs; a view receives the
// params and returns a cleanup function (or nothing).

let routes = [];
let cleanup = null;

export function defineRoutes(list) {
  routes = list.map(([pattern, view]) => {
    const keys = [];
    const source = pattern.replace(/:([a-z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    return { regex: new RegExp(`^${source}/?$`), keys, view };
  });
}

export function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  render();
}

export function render() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  for (const r of routes) {
    const m = r.regex.exec(location.pathname);
    if (m) {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      cleanup = r.view(params);
      window.scrollTo(0, 0);
      return;
    }
  }
  navigate('/', { replace: true });
}

export function startRouter() {
  window.addEventListener('popstate', render);
  // Intercept same-origin links so navigation stays client-side.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  render();
}
