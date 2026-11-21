// Retro Poker Club — first-time account setup.
// An admin adds an email in Members and gets a 6-digit invite code (valid 7 days).
// The person sets their own password here with email + code.
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

const MESSAGES: Record<string, [number, string]> = {
  not_invited: [403, "This email isn't invited, or already has a login. Ask an admin."],
  wrong_code: [403, "Wrong invite code."],
  expired: [403, "This invite code has expired. Ask an admin for a new one."],
  locked: [403, "Too many wrong codes. Ask an admin for a new one."],
};

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
  if (code.length !== 6) return reply(400, { error: "Enter the 6-digit invite code" });
  if (password.length < 8) return reply(400, { error: "Password must be at least 8 characters" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: status, error: prepErr } = await admin.rpc("claim_prepare", { p_email: email, p_code: code });
  if (prepErr) return reply(500, { error: "Server error, try again" });
  if (status !== "ok") {
    const [st, msg] = MESSAGES[String(status)] || [403, "Not allowed"];
    return reply(st, { error: msg });
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr || !created?.user) return reply(400, { error: createErr?.message || "Couldn't create the login" });

  const { error: linkErr } = await admin
    .from("members")
    .update({ user_id: created.user.id, invite_hash: null, invite_expires: null, invite_attempts: 0 })
    .eq("email", email)
    .is("user_id", null);
  if (linkErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return reply(500, { error: "Server error, try again" });
  }
  return reply(200, { ok: true });
});
