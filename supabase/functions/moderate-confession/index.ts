// Moderator login, list and delete for confessions and their comments.
// Requires secret MODERATOR_PASSPHRASE (Supabase edge function secrets).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
// Tokens are "<expiry-ms>.<hmac-hex>", signed with the passphrase, valid 8 hours.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SESSION_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Constant-time comparison so secrets cannot be guessed by timing.
function same(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function sign(secret: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`moderator:${exp}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validToken(secret: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string") return false;
  const [expStr, mac] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false;
  return same(mac, await sign(secret, exp));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  // Fail closed: no secret set means no moderator access at all.
  const secret = Deno.env.get("MODERATOR_PASSPHRASE");
  if (!secret) return json(503, { error: "not_configured" });

  if (payload?.action === "login") {
    const given = typeof payload?.passphrase === "string" ? payload.passphrase : "";
    if (!given || !same(given, secret)) return json(401, { error: "unauthorized" });
    const exp = Date.now() + SESSION_MS;
    return json(200, { token: `${exp}.${await sign(secret, exp)}`, expires_at: exp });
  }

  if (!(await validToken(secret, payload?.token))) {
    return json(401, { error: "session_expired" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key!, Authorization: `Bearer ${key}` };

  if (payload?.action === "list") {
    const r = await fetch(
      `${url}/rest/v1/confessions?select=id,body,created_at&order=created_at.desc&limit=500`,
      { headers },
    );
    if (!r.ok) return json(500, { error: "list_failed" });
    return json(200, { confessions: await r.json() });
  }

  if (payload?.action === "delete") {
    const id = payload?.id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
      return json(400, { error: "bad_id" });
    }
    const r = await fetch(`${url}/rest/v1/confessions?id=eq.${id}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=minimal" },
    });
    if (!r.ok) return json(500, { error: "delete_failed" });
    return json(200, { status: "deleted" });
  }

  if (payload?.action === "comments") {
    const r = await fetch(
      `${url}/rest/v1/confession_comments?select=id,confession_id,body,created_at,report_count,hidden&order=created_at.desc&limit=500`,
      { headers },
    );
    if (!r.ok) return json(500, { error: "list_failed" });
    return json(200, { comments: await r.json() });
  }

  if (payload?.action === "delete_comment") {
    const id = payload?.id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
      return json(400, { error: "bad_id" });
    }
    const r = await fetch(`${url}/rest/v1/confession_comments?id=eq.${id}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=minimal" },
    });
    if (!r.ok) return json(500, { error: "delete_failed" });
    return json(200, { status: "deleted" });
  }

  return json(400, { error: "unknown_action" });
});
