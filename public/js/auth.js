/**
 * auth.js — Login, register, logout via Supabase JS SDK.
 * Exposes: Auth.login(), Auth.register(), Auth.logout(), Auth.getSession()
 */

const Auth = (() => {
  async function login(email, password) {
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function register(email, password) {
    const { data, error } = await window.sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function logout() {
    const { error } = await window.sb.auth.signOut();
    if (error) throw error;
    window.location.href = "/index.html";
  }

  async function getSession() {
    const { data } = await window.sb.auth.getSession();
    return data?.session ?? null;
  }

  async function getJwt() {
    const session = await getSession();
    return session?.access_token ?? null;
  }

  async function requireAuth(redirectTo = "/login.html") {
    const session = await getSession();
    if (!session) {
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  async function requireAdmin(redirectTo = "/index.html") {
    const session = await requireAuth();
    if (!session) return null;
    const role = session.user?.app_metadata?.role;
    if (role !== "admin") {
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  // Listen for auth state changes
  window.sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      // Clear any cached data
      window.dispatchEvent(new CustomEvent("auth:signed_out"));
    }
    if (event === "SIGNED_IN") {
      window.dispatchEvent(new CustomEvent("auth:signed_in", { detail: session }));
    }
  });

  async function signInAnon() {
    if (typeof window.sb.auth.signInAnonymously !== "function") {
      throw new Error("Anonymous sign-in not supported by this Supabase client version. Hard-refresh and try again.");
    }
    const { data, error } = await window.sb.auth.signInAnonymously();
    if (error) {
      console.error("[Auth.signInAnon] Supabase error:", error);
      throw error;
    }
    return data.session?.access_token ?? null;
  }

  function isAnonymous(session) {
    return !!session?.user?.is_anonymous;
  }

  return { login, register, logout, getSession, getJwt, requireAuth, requireAdmin, signInAnon, isAnonymous };
})();

window.Auth = Auth;
