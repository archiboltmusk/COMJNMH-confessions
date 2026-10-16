// Report a comment. One report per device per comment (enforced by the
// primary key). A comment with 3 or more reports is hidden from readers
// until a moderator reviews it.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-device-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HIDE_AT = 3;
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
  const commentId = typeof payload?.comment_id === "string" ? payload.comment_id : "";
  if (!UUID.test(commentId)) return json(400, { error: "bad_comment" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const db = { apikey: key!, Authorization: `Bearer ${key}` };
  const deviceHash = await hashDevice(deviceId);

  const ins = await fetch(`${url}/rest/v1/comment_reports`, {
    method: "POST",
    headers: { ...db, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({ comment_id: commentId, device_hash: deviceHash }),
  });
  if (!ins.ok) return json(404, { error: "not_found" });

  const counted = await fetch(
    `${url}/rest/v1/comment_reports?select=device_hash&comment_id=eq.${commentId}`,
    { headers: { ...db, Prefer: "count=exact", Range: "0-0" } },
  );
  if (!counted.ok) return json(500, { error: "store_failed" });
  const count = Number((counted.headers.get("content-range") ?? "0/0").split("/")[1] ?? 0);

  const upd = await fetch(`${url}/rest/v1/confession_comments?id=eq.${commentId}`, {
    method: "PATCH",
    headers: { ...db, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ report_count: count, hidden: count >= HIDE_AT }),
  });
  if (!upd.ok) return json(500, { error: "store_failed" });
  return json(200, { reported: true });
});
