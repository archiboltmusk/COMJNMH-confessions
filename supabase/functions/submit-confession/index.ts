// Moderated confession submission. Flagged text is never stored.
// Course and batch are optional. Free text under "Other" is moderated too.
// Requires secret OPENAI_API_KEY (Supabase edge function secrets).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OTHER = "Other";

const COURSES = [
  "MBBS", "DNB", "MD", "MS", "Bsc CCT", "Bsc PA", "BHA", "MHA", "Diploma CCT",
  "DMLT", "Diploma ECG", "BSc OTT", "BMLT", "Bsc PT", "Bsc Nursing", OTHER,
];

const BATCHES = [
  "1st Year", "2nd Year", "3rd Year", "4th Year", "Intern",
  "House-staff/Junior Resident", "Alumni", "PGY1", "PGY2", "PGY3",
  "Senior Resident", OTHER,
];

// Only values from the fixed list are stored. Anything else is dropped.
const pick = (value: unknown, allowed: string[]): string | null =>
  typeof value === "string" && allowed.includes(value) ? value : null;

const freeText = (value: unknown): string | null => {
  const t = typeof value === "string" ? value.trim() : "";
  return t.length >= 1 && t.length <= 60 ? t : null;
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
  let course: string | null = null;
  let courseOther: string | null = null;
  let batch: string | null = null;
  let batchOther: string | null = null;
  try {
    const payload = await req.json();
    text = typeof payload?.body === "string" ? payload.body.trim() : "";
    course = pick(payload?.course, COURSES);
    batch = pick(payload?.batch, BATCHES);
    courseOther = course === OTHER ? freeText(payload?.course_other) : null;
    batchOther = batch === OTHER ? freeText(payload?.batch_other) : null;
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (text.length < 1 || text.length > 1000) {
    return json(400, { error: "length_must_be_1_to_1000" });
  }
  if ((course === OTHER && !courseOther) || (batch === OTHER && !batchOther)) {
    return json(400, { error: "other_text_required" });
  }

  // Fail closed: if moderation is unavailable, nothing is published.
  const modRes = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: [text, courseOther, batchOther].filter((t): t is string => !!t),
    }),
  });
  if (!modRes.ok) return json(503, { error: "moderation_unavailable" });

  const modData = await modRes.json();
  if ((modData?.results ?? []).some((r: { flagged: boolean }) => r.flagged)) {
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
    body: JSON.stringify({
      body: text,
      course,
      course_other: courseOther,
      batch,
      batch_other: batchOther,
    }),
  });
  if (!insRes.ok) return json(500, { error: "store_failed" });

  return json(201, { status: "published" });
});
