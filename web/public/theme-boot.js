// Paint the stored theme before first render (no dark flash in light mode).
// A file, not an inline script: the page's CSP allows only 'self' scripts.
try {
  var m = localStorage.getItem('ah.theme') || 'system';
  var t = m === 'light' || m === 'dark' ? m : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  if (t === 'light') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#ffffff');
} catch (e) {}
