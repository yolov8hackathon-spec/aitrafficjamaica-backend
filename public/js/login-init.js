function redirectByRole(session) {
  const role = session?.user?.app_metadata?.role;
  window.location.href = role === "admin" ? "/admin.html" : "/index.html";
}

Auth.getSession().then(s => {
  if (s) redirectByRole(s);
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("auth-error");
  const btn = document.getElementById("submit-btn");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in...";

  try {
    const { session } = await Auth.login(
      document.getElementById("email").value,
      document.getElementById("password").value
    );
    redirectByRole(session);
  } catch (err) {
    errorEl.textContent = err.message || "Login failed";
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});
