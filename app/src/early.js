// Runs before anything is drawn. If this site was built with an access code and this device hasn't been let in yet,
// it marks the page as gated, so the app is never shown, and gives the tab a plain title. (A classic script on
// purpose: it must run first, and it can't wait for the rest of the app to load.)
(function () {
  var meta = document.querySelector('meta[name="app-access"]');
  var spec = meta && meta.getAttribute('content');
  if (!spec) return;
  var m = /^v1\.\d+\.[A-Za-z0-9_-]+\.([0-9a-f]{64})$/.exec(spec.trim());
  if (!m) return;
  var granted = null;
  try { granted = localStorage.getItem('my-budget-access'); } catch (e) { granted = null; }
  if (granted === m[1].slice(0, 16)) return;
  document.documentElement.setAttribute('data-gated', '1');
  document.title = 'Private';
})();
