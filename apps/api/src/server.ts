import Fastify from "fastify";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";
import twilio from "twilio";

dotenv.config();

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false
});

const hasTwilio =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_PHONE_NUMBER &&
  process.env.TWILIO_ACCOUNT_SID !== "replace_me";

const smsClient = hasTwilio
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const intakeSchema = z.object({
  channel: z.enum(["voice", "form", "sms", "chat"]).default("voice"),
  caller_phone: z.string().min(7, "caller_phone is required"),
  caller_name: z.string().optional().default("Unknown"),
  service_address: z.string().optional().default("Unknown"),
  home_or_business: z.enum(["home", "business"]).optional().default("home"),
  issue_type: z.string().optional().default("general"),
  urgency: z.enum(["normal", "urgent", "emergency"]).default("normal"),
  source: z.string().optional().default("inbound"),
  preferred_contact_method: z.enum(["sms", "call", "email"]).optional().default("sms"),
  language: z.enum(["en", "es"]).optional().default("en"),
  summary: z.string().optional().default(""),
  raw_payload: z.any().optional().default({})
});

function autoClassifyUrgency(input: {
  issue_type?: string;
  summary?: string;
  urgency?: "normal" | "urgent" | "emergency";
}) {
  if (input.urgency === "emergency") return "emergency";

  const text = `${input.issue_type || ""} ${input.summary || ""}`.toLowerCase();

  const emergencyTriggers = [
    "active leak",
    "flood",
    "flooding",
    "sewer backup",
    "sewage backup",
    "water everywhere",
    "burst pipe",
    "no water",
    "overflow",
    "backing up"
  ];

  if (emergencyTriggers.some((t) => text.includes(t))) {
    return "emergency";
  }

  const urgentTriggers = [
    "leak",
    "water heater",
    "clog",
    "drain",
    "toilet",
    "backup"
  ];

  if (urgentTriggers.some((t) => text.includes(t))) {
    return "urgent";
  }

  return "normal";
}

async function sendConfirmationSms(phone: string, urgency: string) {
  if (!smsClient) {
    app.log.warn("Twilio not configured; skipping SMS");
    return;
  }

  const body =
    urgency === "emergency"
      ? "Bob's Plumbing: We received your emergency request and marked it priority. We will follow up as soon as possible."
      : "Bob's Plumbing: We received your request and will follow up shortly.";

  await smsClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
    body
  });
}

async function createTicket(data: z.infer<typeof intakeSchema>) {
  const finalUrgency = autoClassifyUrgency(data);

  const result = await pool.query(
    `
    insert into tickets
    (
      channel,
      caller_phone,
      caller_name,
      service_address,
      home_or_business,
      issue_type,
      urgency,
      status,
      source,
      preferred_contact_method,
      language,
      summary,
      raw_payload
    )
    values
    ($1,$2,$3,$4,$5,$6,$7,'new',$8,$9,$10,$11,$12)
    returning id, urgency, status, created_at
    `,
    [
      data.channel,
      data.caller_phone,
      data.caller_name,
      data.service_address,
      data.home_or_business,
      data.issue_type,
      finalUrgency,
      data.source,
      data.preferred_contact_method,
      data.language,
      data.summary,
      data.raw_payload
    ]
  );

  const ticket = result.rows[0];

  try {
    await sendConfirmationSms(data.caller_phone, ticket.urgency);
  } catch (err) {
    app.log.error(err, "SMS send failed");
  }

  return ticket;
}

app.get("/health", async () => {
  const db = await pool.query("select now() as now");
  return {
    ok: true,
    db: true,
    time: db.rows[0].now
  };
});

app.post("/intake", async (request, reply) => {
  const parsed = intakeSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: parsed.error.flatten()
    });
  }

  const ticket = await createTicket(parsed.data);

  return {
    ok: true,
    route: ticket.urgency === "emergency" ? "emergency_escalation" : "standard_queue",
    ticket
  };
});

app.post("/intake/form", async (request, reply) => {
  const parsed = intakeSchema.safeParse({
    ...(request.body as object),
    channel: "form",
    source: "web_form"
  });

  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: parsed.error.flatten()
    });
  }

  const ticket = await createTicket(parsed.data);

  return {
    ok: true,
    route: ticket.urgency === "emergency" ? "emergency_escalation" : "standard_queue",
    ticket
  };
});

app.post("/intake/voice", async (request, reply) => {
  const parsed = intakeSchema.safeParse({
    ...(request.body as object),
    channel: "voice",
    source: "voice_agent"
  });

  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: parsed.error.flatten()
    });
  }

  const ticket = await createTicket(parsed.data);

  return {
    ok: true,
    route: ticket.urgency === "emergency" ? "emergency_escalation" : "standard_queue",
    ticket
  };
});

app.listen({
  port: Number(process.env.PORT || 3000),
  host: "0.0.0.0"
}).then(() => {
  app.log.info("bobsplumbing-ai API running");
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
