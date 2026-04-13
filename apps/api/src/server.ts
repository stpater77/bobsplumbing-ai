import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";
import twilio from "twilio";

dotenv.config();

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
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
  raw_payload: z.any().optional().default({}),
});

type IntakeInput = z.infer<typeof intakeSchema>;
type TicketRow = {
  id: number | string;
  urgency: "normal" | "urgent" | "emergency";
  status: string;
  created_at: string;
};

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
    "backing up",
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
    "backup",
  ];

  if (urgentTriggers.some((t) => text.includes(t))) {
    return "urgent";
  }

  return "normal";
}

function getRouteForTicket(ticket: TicketRow, source?: string) {
  if (source === "failed_transfer") return "callback_recovery";
  if (source === "missed_call") return "callback_recovery";
  if (source === "after_hours" && ticket.urgency === "emergency") {
    return "emergency_escalation";
  }
  if (ticket.urgency === "emergency") return "emergency_escalation";
  if (ticket.urgency === "urgent") return "priority_queue";
  return "standard_queue";
}

function buildSmsBody(source: string, urgency: string) {
  if (source === "missed_call") {
    return "Bob's Plumbing: Sorry we missed your call. We received your request and will follow up shortly.";
  }

  if (source === "failed_transfer") {
    return "Bob's Plumbing: We received your request, but your live transfer did not complete. We will follow up as soon as possible.";
  }

  if (source === "after_hours" && urgency === "emergency") {
    return "Bob's Plumbing: We received your after-hours emergency request and marked it priority. We will follow up as soon as possible.";
  }

  if (urgency === "emergency") {
    return "Bob's Plumbing: We received your emergency request and marked it priority. We will follow up as soon as possible.";
  }

  return "Bob's Plumbing: We received your request and will follow up shortly.";
}

async function sendConfirmationSms(phone: string, urgency: string, source: string) {
  if (!smsClient) {
    app.log.warn(
      {
        hasAccountSid: !!process.env.TWILIO_ACCOUNT_SID,
        hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
        hasPhoneNumber: !!process.env.TWILIO_PHONE_NUMBER,
      },
      "Twilio not configured; skipping SMS"
    );
    return;
  }

  const body = buildSmsBody(source, urgency);

  app.log.info(
    {
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      urgency,
      source,
    },
    "Twilio send attempt starting"
  );

  const message = await smsClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
    body,
  });

  app.log.info(
    {
      sid: message.sid,
      status: message.status,
      to: phone,
      source,
    },
    "Twilio send attempt completed"
  );
}

async function createTicket(data: IntakeInput) {
  const finalUrgency = autoClassifyUrgency(data);

  app.log.info(
    {
      channel: data.channel,
      source: data.source,
      caller_phone: data.caller_phone,
      preferred_contact_method: data.preferred_contact_method,
      requested_urgency: data.urgency,
      final_urgency: finalUrgency,
    },
    "Creating ticket"
  );

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
      data.raw_payload,
    ]
  );

  const ticket: TicketRow = result.rows[0];

  app.log.info(
    {
      ticketId: ticket.id,
      urgency: ticket.urgency,
      status: ticket.status,
      createdAt: ticket.created_at,
      route: getRouteForTicket(ticket, data.source),
    },
    "Ticket created"
  );

  try {
    await sendConfirmationSms(data.caller_phone, ticket.urgency, data.source);
  } catch (err: any) {
    app.log.error(
      {
        message: err?.message,
        code: err?.code,
        status: err?.status,
        moreInfo: err?.moreInfo,
      },
      "SMS send failed"
    );
  }

  return ticket;
}

async function handleIntake(payload: unknown, overrides: Partial<IntakeInput>) {
  const parsed = intakeSchema.safeParse({
    ...(payload as object),
    ...overrides,
  });

  if (!parsed.success) {
    return {
      ok: false as const,
      statusCode: 400,
      error: parsed.error.flatten(),
    };
  }

  const ticket = await createTicket(parsed.data);

  return {
    ok: true as const,
    statusCode: 200,
    route: getRouteForTicket(ticket, parsed.data.source),
    ticket,
  };
}

async function start() {
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  app.log.info(
    {
      hasTwilio,
      hasAccountSid: !!process.env.TWILIO_ACCOUNT_SID,
      hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
      hasPhoneNumber: !!process.env.TWILIO_PHONE_NUMBER,
    },
    "Startup configuration"
  );

  app.get("/health", async () => {
    const db = await pool.query("select now() as now");
    return {
      ok: true,
      db: true,
      time: db.rows[0].now,
    };
  });

  app.post("/intake", async (request, reply) => {
    app.log.info("POST /intake received");

    const result = await handleIntake(request.body, {});

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  app.post("/intake/form", async (request, reply) => {
    app.log.info("POST /intake/form received");

    const result = await handleIntake(request.body, {
      channel: "form",
      source: "web_form",
    });

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake/form");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  app.post("/intake/voice", async (request, reply) => {
    app.log.info("POST /intake/voice received");

    const result = await handleIntake(request.body, {
      channel: "voice",
      source: "voice_agent",
    });

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake/voice");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  app.post("/intake/missed-call", async (request, reply) => {
    app.log.info("POST /intake/missed-call received");

    const result = await handleIntake(request.body, {
      channel: "voice",
      source: "missed_call",
      summary: "Missed inbound call",
      preferred_contact_method: "sms",
    });

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake/missed-call");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  app.post("/intake/failed-transfer", async (request, reply) => {
    app.log.info("POST /intake/failed-transfer received");

    const result = await handleIntake(request.body, {
      channel: "voice",
      source: "failed_transfer",
      summary: "Live transfer failed or timed out",
      preferred_contact_method: "call",
      urgency: "urgent",
    });

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake/failed-transfer");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  app.post("/intake/after-hours", async (request, reply) => {
    app.log.info("POST /intake/after-hours received");

    const result = await handleIntake(request.body, {
      channel: "voice",
      source: "after_hours",
      preferred_contact_method: "call",
    });

    if (!result.ok) {
      app.log.warn({ error: result.error }, "Validation failed for /intake/after-hours");
      return reply.status(result.statusCode).send(result);
    }

    return result;
  });

  await app.listen({
    port: Number(process.env.PORT || 3000),
    host: "0.0.0.0",
  });

  app.log.info("bobsplumbing-ai API running");
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
