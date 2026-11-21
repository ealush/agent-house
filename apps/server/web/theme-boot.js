// Paint the stored theme before first render (no dark flash in light mode).
// A file, not an inline script: the page's CSP allows only 'self' scripts.
try {
  var m = localStorage.getItem('ah.theme') || 'system';
  var o = m === 'omarchy' ? JSON.parse(localStorage.getItem('ah.omarchy.palette') || 'null') : null;
  var t = o ? o.mode : m === 'light' || m === 'dark' ? m : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  // Omarchy: the cached desktop background, so the first paint isn't ah's own.
  if (o && o.colors && o.colors.background) document.documentElement.style.background = o.colors.background;
  document.documentElement.dataset.theme = t;
  if (t === 'light') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#eef0f4');
} catch (e) {}
