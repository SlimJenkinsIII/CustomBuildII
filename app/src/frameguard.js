// Clickjacking guard. The usual defence is a header telling browsers not to let other sites put this page
// in a frame, but GitHub Pages doesn't let us send headers. So instead: the page starts hidden (a style in
// index.html), and this script reveals it only when it is the top-level page. Inside someone else's frame it
// stays blank, so nobody can lay an invisible copy of the app over a page of theirs and trick a tap.
// If this script fails to load, the page stays hidden: it fails closed.
(function () {
  var shield = document.getElementById('antiframe');
  var framed = true;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed && shield) shield.remove();
})();
