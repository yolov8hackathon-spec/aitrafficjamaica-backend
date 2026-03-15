Auth.getSession().then(s => {
  if (s) window.location.href = "/account.html";
});

document.getElementById("reg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("auth-error");
  const successEl = document.getElementById("auth-success");
  const btn = document.getElementById("submit-btn");

  errorEl.textContent = "";
  successEl.textContent = "";

  const pw = document.getElementById("password").value;
  const confirm = document.getElementById("confirm").value;
  if (pw !== confirm) {
    errorEl.textContent = "Passwords do not match";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Creating account...";

  try {
    await Auth.register(
      document.getElementById("email").value,
      pw
    );
    successEl.textContent = "Account created! Check your email to confirm, then log in.";
    btn.textContent = "Done";
  } catch (err) {
    errorEl.textContent = err.message || "Registration failed";
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
});
