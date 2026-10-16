// Moderated confession submission. Flagged text is never stored.
// Requires secret OPENAI_API_KEY (Supabase edge function secrets).
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let text = "";
  try {
    const payload = await req.json();
    text = typeof payload?.body === "string" ? payload.body.trim() : "";
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (text.length < 1 || text.length > 1000) {
    return json(400, { error: "length_must_be_1_to_1000" });
  }

  // Fail closed: if moderation is unavailable, nothing is published.
  const modRes = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
  });
  if (!modRes.ok) return json(503, { error: "moderation_unavailable" });

  const modData = await modRes.json();
  if (modData?.results?.[0]?.flagged) {
    return json(422, { error: "rejected" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const insRes = await fetch(`${url}/rest/v1/confessions`, {
    method: "POST",
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ body: text }),
  });
  if (!insRes.ok) return json(500, { error: "store_failed" });

  return json(201, { status: "published" });
});
