// Retro Poker Club — forgot password.
// Email + the current 6-digit code from Google Authenticator → new password.
// The code is checked inside the database (reset_prepare); 5 wrong codes lock it for 15 minutes.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://ttomov88.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  let email = "", password = "", code = "";
  try {
    const body = await req.json();
    email = String(body.email || "").trim().toLowerCase();
    password = String(body.password || "");
    code = String(body.code || "").replace(/\D/g, "");
  } catch (_) {
    return reply(400, { error: "Bad request" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid email" });
  if (code.length !== 6) return reply(400, { error: "Enter the 6-digit code from Google Authenticator" });
  if (password.length < 8) return reply(400, { error: "Password must be at least 8 characters" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: status, error } = await admin.rpc("reset_prepare", { p_email: email, p_code: code });
  if (error) return reply(500, { error: "Server error, try again" });
  const result = String(status || "");
  if (result === "locked") return reply(429, { error: "Too many wrong codes. Try again in 15 minutes." });
  if (!result.startsWith("ok:")) {
    return reply(403, { error: "Wrong email or code. No authenticator set up? Ask an admin to reset your login." });
  }

  const userId = result.slice(3);
  const { error: updErr } = await admin.auth.admin.updateUserById(userId, { password });
  if (updErr) return reply(400, { error: updErr.message || "Couldn't change the password" });
  return reply(200, { ok: true });
});
