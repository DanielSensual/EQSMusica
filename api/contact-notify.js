/**
 * Formspree webhook → Twilio SMS for high-priority EQS inquiries.
 *
 * Vercel env (Production + Preview):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER          E.164 Twilio number (e.g. +14075551234)
 *   NOTIFY_PHONE_NUMBER         E.164 phone to alert (e.g. Derek's mobile)
 *   FORMSPREE_WEBHOOK_SECRET    optional; set same value in Formspree custom header
 *
 * Formspree → Settings → Webhooks → URL:
 *   https://www.eqsmusica.com/api/contact-notify
 */

const PRIORITY_INTENTS = new Set(["booking", "artist-submission"]);

const INTENT_LABELS = {
  booking: "Booking request",
  "artist-submission": "Artist / demo submission",
  press: "Press inquiry",
  collaboration: "Production / collaboration",
  other: "General inquiry",
};

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function badRequest(message) {
  return new Response(message, { status: 400 });
}

function normalizePayload(body) {
  if (!body || typeof body !== "object") return {};
  if (body.data && typeof body.data === "object") return body.data;
  return body;
}

function buildSms({ intent, name, email, message, musicLink }) {
  const label = INTENT_LABELS[intent] || intent || "Inquiry";
  const lines = [
    `EQS Música — ${label}`,
    name ? `From: ${name}` : null,
    email ? `Email: ${email}` : null,
    musicLink ? `Link: ${musicLink}` : null,
    message ? `Message: ${message.slice(0, 280)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

async function sendTwilioSms({ to, from, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken || !from || !to) {
    throw new Error("Missing Twilio configuration");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Twilio error ${response.status}: ${detail}`);
  }

  return response.json();
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = process.env.FORMSPREE_WEBHOOK_SECRET;
  if (secret) {
    const header =
      request.headers.get("x-formspree-secret") ||
      request.headers.get("x-webhook-secret");
    if (header !== secret) return unauthorized();
  }

  let raw;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const data = normalizePayload(raw);
  const intent = String(data.intent || data._subject || "").toLowerCase();

  if (!PRIORITY_INTENTS.has(intent)) {
    return Response.json({ ok: true, skipped: true, reason: "non-priority intent" });
  }

  const name = data.name || data._replyto || "";
  const email = data.email || "";
  const message = data.message || "";
  const musicLink = data.music_link || data.musicLink || "";

  try {
    const sid = await sendTwilioSms({
      to: process.env.NOTIFY_PHONE_NUMBER,
      from: process.env.TWILIO_FROM_NUMBER,
      body: buildSms({ intent, name, email, message, musicLink }),
    });

    return Response.json({
      ok: true,
      notified: true,
      intent,
      messageSid: sid.sid,
    });
  } catch (err) {
    console.error("contact-notify failed:", err);
    return new Response("Failed to send notification", { status: 500 });
  }
}
