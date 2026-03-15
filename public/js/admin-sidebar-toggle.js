(function () {
  var sidebar  = document.getElementById("admin-sidebar");
  var overlay  = document.getElementById("sidebar-overlay");
  var openBtn  = document.getElementById("topbar-hamburger");
  var closeBtn = document.getElementById("sidebar-toggle");
  function open()  { sidebar.classList.add("open");    overlay.classList.add("visible"); }
  function close() { sidebar.classList.remove("open"); overlay.classList.remove("visible"); }
  if (openBtn)  openBtn.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (overlay)  overlay.addEventListener("click", close);
})();
