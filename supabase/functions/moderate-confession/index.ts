// Moderator list + delete for confessions. Passphrase checked server-side.
// Requires secret MODERATOR_PASSPHRASE (Supabase edge function secrets).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Constant-time comparison so the passphrase cannot be guessed by timing.
function same(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
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
  const expected = Deno.env.get("MODERATOR_PASSPHRASE");
  if (!expected) return json(503, { error: "not_configured" });
  const given = typeof payload?.passphrase === "string" ? payload.passphrase : "";
  if (!given || !same(given, expected)) return json(401, { error: "unauthorized" });

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

  return json(400, { error: "unknown_action" });
});
