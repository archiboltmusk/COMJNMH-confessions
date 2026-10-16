// Anonymous comment on a confession. Same moderation as confessions:
// flagged text is refused and never stored; moderation outage fails closed.
// Rate limit: 5 comments per device per 10 minutes.
// Requires secret OPENAI_API_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected by Supabase.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-device-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function hashDevice(id: string): Promise<string> {
  const mac = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const deviceId = req.headers.get("x-device-id") ?? "";
  if (deviceId.length < 8 || deviceId.length > 128) return json(400, { error: "bad_device" });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const confessionId = typeof payload?.confession_id === "string" ? payload.confession_id : "";
  const text = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!UUID.test(confessionId)) return json(400, { error: "bad_confession" });
  if (text.length < 1 || text.length > 500) return json(400, { error: "length_must_be_1_to_500" });
  // Optional Instagram handle: leading @ allowed, letters, numbers, dots and underscores only.
  const rawHandle = typeof payload?.instagram === "string" ? payload.instagram.trim().replace(/^@/, "") : "";
  if (rawHandle && !/^[A-Za-z0-9._]{1,30}$/.test(rawHandle)) return json(400, { error: "bad_instagram" });
  const handle = rawHandle || null;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const db = { apikey: key!, Authorization: `Bearer ${key}` };
  const deviceHash = await hashDevice(deviceId);

  // The confession must exist and be the parent of this comment.
  const parent = await fetch(`${url}/rest/v1/confessions?select=id&id=eq.${confessionId}`, { headers: db });
  if (!parent.ok) return json(500, { error: "store_failed" });
  if ((await parent.json()).length === 0) return json(404, { error: "not_found" });

  // Rate limit per device.
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const recent = await fetch(
    `${url}/rest/v1/confession_comments?select=id&device_hash=eq.${deviceHash}&created_at=gte.${since}`,
    { headers: { ...db, Prefer: "count=exact", Range: "0-0" } },
  );
  if (!recent.ok) return json(500, { error: "store_failed" });
  const total = Number((recent.headers.get("content-range") ?? "0/0").split("/")[1] ?? 0);
  if (total >= MAX_PER_WINDOW) return json(429, { error: "rate_limited" });

  // Same moderation as confessions.
  const modRes = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input: handle ? [text, handle] : [text] }),
  });
  if (!modRes.ok) return json(503, { error: "moderation_unavailable" });
  const modData = await modRes.json();
  if ((modData?.results ?? []).some((r: { flagged: boolean }) => r.flagged)) return json(422, { error: "rejected" });

  const insRes = await fetch(`${url}/rest/v1/confession_comments`, {
    method: "POST",
    headers: { ...db, "Content-Type": "application/json", Prefer: "return=representation" },
    // The handle column is sent only when a handle is given, so comments without one never touch it.
    body: JSON.stringify({ confession_id: confessionId, body: text, device_hash: deviceHash, ...(handle ? { instagram: handle } : {}) }),
  });
  if (!insRes.ok) return json(500, { error: "store_failed" });
  const [row] = await insRes.json();
  return json(201, {
    comment: {
      id: row.id,
      confession_id: row.confession_id,
      body: row.body,
      created_at: row.created_at,
      instagram: row.instagram ?? null,
    },
  });
});
