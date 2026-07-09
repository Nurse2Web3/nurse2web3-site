// NoteGen AI backend — Cloudflare Worker.
// Holds the Anthropic API key as a secret (never exposed to the browser),
// turns a nurse's shorthand into a professional narrative nursing note.
// Deploy: `wrangler deploy`. Set the key: `wrangler secret put ANTHROPIC_API_KEY`.

// ponytail: allowlist, not a full CORS lib. Add origins here as the site grows.
const ALLOWED_ORIGINS = [
  "https://nurse2web3.com",
  "https://www.nurse2web3.com",
  "https://nurse2web3.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const NOTE_TYPES = {
  narrative:   "a general ER narrative nursing note",
  sbar:        "an SBAR-format note with clear Situation, Background, Assessment, and Recommendation sections (label each section)",
  transfer:    "a transfer note documenting the patient's status and reason for transfer",
  admit:       "an admission note documenting the patient's status on admission",
  discharge:   "a discharge note documenting condition at discharge and instructions given",
  assessment:  "a focused shift-assessment note",
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function systemPrompt(noteTypeDesc) {
  return `You are an experienced ER nurse writing ${noteTypeDesc} from a colleague's shorthand notes. Produce professional, chart-ready nursing documentation in flowing narrative prose.

ABSOLUTE RULES:
1. Document ONLY what the nurse states. NEVER invent vital signs, medications, doses, times, assessment findings, or clinical events that were not provided. If a normal-sounding detail wasn't given, do not add it.
2. For anything relevant but not provided, insert a clearly bracketed placeholder the nurse will fill in, e.g. [document vital signs], [time], [dose/route], [provider name].
3. NEVER write patient identifiers. Refer to the patient as "[Patient]" and use placeholders "[MRN]" and "[DOB]" — the nurse fills these into the chart after pasting.
4. Use standard professional nursing charting language and an objective clinical tone. Expand shorthand and abbreviations into proper documentation while preserving the clinical meaning exactly.
5. Do not fabricate a plan, disposition, or patient response the nurse did not indicate.

Output ONLY the note text. No preamble, no headings like "Note:", no commentary.`;
}

const LOOKUP_SYSTEM = `You are a clinical educator supporting ER and hospital nurses. The user gives you a medical diagnosis or condition. Respond with exactly two clearly-labeled sections using this markdown:

**Overview**
A concise, plain-language explanation of the condition: brief pathophysiology, common causes, and the hallmark signs and symptoms a nurse would assess for.

**Nursing Interventions**
A prioritized bulleted list (use "- " for each item) of relevant nursing assessments, monitoring, and interventions for this condition — what to assess and monitor, positioning, interventions to anticipate/administer per order, patient education, and signs that warrant escalation.

Keep it practical and scannable. This is general clinical education and reference ONLY — it is NOT a care plan, NOT a substitute for facility protocol, provider orders, or the nurse's own clinical judgment. Do not give specific medication doses; note that all orders come from the provider. If the input is not a recognizable medical condition, say so briefly and stop.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const mode = body.mode === "lookup" ? "lookup" : "note";
    const input = (body.input || "").toString().trim();
    if (!input) return json({ error: "No input provided" }, 400, cors);
    if (input.length > 4000) return json({ error: "Input too long" }, 400, cors);

    let system, maxTokens;
    if (mode === "lookup") {
      system = LOOKUP_SYSTEM;
      maxTokens = 2000;
    } else {
      const noteType = NOTE_TYPES[body.noteType] ? body.noteType : "narrative";
      system = systemPrompt(NOTE_TYPES[noteType]);
      maxTokens = 1500;
    }

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: maxTokens,
        thinking: { type: "disabled" },   // system prompt enforces clean, output-only responses
        system,
        messages: [{ role: "user", content: input }],
      }),
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      return json({ error: "AI service error", status: apiRes.status, detail }, 502, cors);
    }

    const data = await apiRes.json();
    const note = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!note) return json({ error: "Empty response", stop_reason: data.stop_reason }, 502, cors);
    return json({ note }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
