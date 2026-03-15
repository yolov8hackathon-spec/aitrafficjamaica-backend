/**
 * supabase-init.js — Initialise the Supabase client with anon key.
 * SUPABASE_URL and SUPABASE_ANON_KEY are injected at build time via Vercel
 * and embedded as window globals in a <script> tag in each HTML page.
 * Both are safe to expose (RLS enforces all access).
 */

// Expects window.SUPABASE_URL and window.SUPABASE_ANON_KEY to be set
// by the inline config script block in each HTML page.
const { createClient } = supabase;

window.sb = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
