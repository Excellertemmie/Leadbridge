// Vercel serverless function: receives the website contact form, saves the lead in Brevo
// and emails you a notification. Secrets live in Vercel Environment Variables, never in the page.
//
// Required env vars (Vercel -> Project -> Settings -> Environment Variables):
//   BREVO_API_KEY        your Brevo API key
//   BREVO_LIST_ID        numeric ID of the Brevo list that should receive the leads
//   BREVO_SENDER_EMAIL   a sender address you have verified in Brevo
//   LEAD_NOTIFY_EMAIL    where new-lead notifications are sent (e.g. temmie@leadbridge.com.ng)

const BREVO = "https://api.brevo.com/v3";

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function brevo(path, apiKey, body) {
  return fetch(BREVO + path, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER_EMAIL, LEAD_NOTIFY_EMAIL } = process.env;
  if (!BREVO_API_KEY || !BREVO_LIST_ID || !BREVO_SENDER_EMAIL || !LEAD_NOTIFY_EMAIL) {
    return res.status(500).json({ ok: false, error: "Lead form is not configured yet." });
  }

  let data = req.body;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = {}; } }
  data = data || {};

  // Honeypot: real visitors never fill this hidden field, bots usually do.
  if (clean(data.company, 200)) return res.status(200).json({ ok: true });

  const firstName = clean(data.firstName, 80);
  const lastName = clean(data.lastName, 80);
  const email = clean(data.email, 200).toLowerCase();
  const service = clean(data.service, 120);
  const message = clean(data.message, 3000);

  if (!firstName || !lastName || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Please check your details and try again." });
  }

  // 1) Save / update the contact in Brevo (same email => updates the existing contact)
  const contactReq = brevo("/contacts", BREVO_API_KEY, {
    email,
    attributes: { FIRSTNAME: firstName, LASTNAME: lastName, SERVICE: service, MESSAGE: message },
    listIds: [Number(BREVO_LIST_ID)],
    updateEnabled: true,
  });

  // 2) Email yourself every enquiry, so no message is ever overwritten or missed
  const mailReq = brevo("/smtp/email", BREVO_API_KEY, {
    sender: { name: "Leadbridge website", email: BREVO_SENDER_EMAIL },
    to: [{ email: LEAD_NOTIFY_EMAIL }],
    replyTo: { email, name: `${firstName} ${lastName}` },
    subject: `New lead: ${service || "Website enquiry"} - ${firstName} ${lastName}`,
    htmlContent:
      `<h2>New website enquiry</h2>` +
      `<p><strong>Name:</strong> ${esc(firstName)} ${esc(lastName)}<br>` +
      `<strong>Email:</strong> ${esc(email)}<br>` +
      `<strong>Service:</strong> ${esc(service)}</p>` +
      `<p><strong>Message:</strong></p><p>${esc(message).replace(/\n/g, "<br>")}</p>`,
  });

  const [c, m] = await Promise.allSettled([contactReq, mailReq]);
  const contactOk = c.status === "fulfilled" && c.value.ok;
  const mailOk = m.status === "fulfilled" && m.value.ok;

  if (!contactOk) console.error("Brevo contact error", c.status === "fulfilled" ? await c.value.text() : c.reason);
  if (!mailOk) console.error("Brevo email error", m.status === "fulfilled" ? await m.value.text() : m.reason);

  // Success if the lead reached you in at least one place
  if (contactOk || mailOk) return res.status(200).json({ ok: true });
  return res.status(502).json({ ok: false, error: "Could not send your message right now." });
};
