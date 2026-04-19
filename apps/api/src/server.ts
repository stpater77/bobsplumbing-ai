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

const hasN8nWebhook =
  !!process.env.N8N_WEBHOOK_URL &&
  process.env.N8N_WEBHOOK_URL !== "replace_me";

const intakeSchema = z.object({
  channel: z.enum(["voice", "form", "sms", "chat"]).default("voice"),
  caller_phone: z.string().min(7, "caller_phone is required"),
  caller_name: z.string().optional().default("Unknown"),
  email: z.string().email().optional().default(""),
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
  id: number;
  ticket_id: string;
  channel: "voice" | "form" | "sms" | "chat";
  caller_phone: string;
  caller_name: string;
  email: string;
  service_address: string;
  home_or_business: "home" | "business";
  issue_type: string;
  urgency: "normal" | "urgent" | "emergency";
  status: string;
  source: string;
  preferred_contact_method: "sms" | "call" | "email";
  language: "en" | "es";
  summary: string;
  raw_payload: unknown;
  created_at: string;
};

type TicketInsertRow = {
  id: number;
  ticket_id: string;
  urgency: "normal" | "urgent" | "emergency";
  status: string;
  created_at: string;
};

type N8nTicketPayload = {
  event_type: "ticket.created";
  ticket: {
    id: number;
    ticket_id: string;
    channel: string;
    caller_phone: string;
    caller_name: string;
    email: string;
    service_address: string;
    home_or_business: string;
    issue_type: string;
    urgency: string;
    status: string;
    source: string;
    preferred_contact_method: string;
    language: string;
    summary: string;
    raw_payload: unknown;
    created_at: string;
  };
};

function autoClassifyUrgency(input: {
  issue_type?: string;
  summary?: string;
  urgency?: "normal" | "urgent" | "emergency";
}) {
  if (input.urgency === "emergency") return "emergency";
  if (input.urgency === "urgent") return "urgent";

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
    "failed transfer",
    "missed call",
  ];

  if (urgentTriggers.some((t) => text.includes(t))) {
    return "urgent";
  }

  return "normal";
}

function getRouteForTicket(
  ticket: Pick<TicketRow, "urgency">,
  source?: string
) {
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

function buildN8nPayload(ticket: TicketRow): N8nTicketPayload {
  return {
    event_type: "ticket.created",
    ticket: {
      id: ticket.id,
      ticket_id: ticket.ticket_id,
      channel: ticket.channel,
      caller_phone: ticket.caller_phone,
      caller_name: ticket.caller_name,
      email: ticket.email,
      service_address: ticket.service_address,
      home_or_business: ticket.home_or_business,
      issue_type: ticket.issue_type,
      urgency: ticket.urgency,
      status: ticket.status,
      source: ticket.source,
      preferred_contact_method: ticket.preferred_contact_method,
      language: ticket.language,
      summary: ticket.summary,
      raw_payload: ticket.raw_payload,
      created_at: ticket.created_at,
    },
  };
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

async function sendTicketToN8n(ticket: TicketRow) {
  if (!hasN8nWebhook) {
    app.log.info("N8N webhook not configured; skipping CRM sync");
    return;
  }

  const payload = buildN8nPayload(ticket);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.N8N_WEBHOOK_SECRET) {
    headers["x-bobs-plumbing-secret"] = process.env.N8N_WEBHOOK_SECRET;
  }

  const response = await fetch(process.env.N8N_WEBHOOK_URL!, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `N8N webhook failed with status ${response.status}${text ? `: ${text}` : ""}`
    );
  }

  app.log.info(
    {
      ticket_id: ticket.ticket_id,
      n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
    },
    "Ticket successfully sent to n8n"
  );
}

async function createTicket(data: IntakeInput): Promise<TicketRow> {
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

  const result = await pool.query<TicketInsertRow>(
    `
    WITH next_ticket_id AS (
      SELECT nextval(pg_get_serial_sequence('tickets', 'id')) AS id
    )
    INSERT INTO tickets
    (
      id,
      ticket_id,
      channel,
      caller_phone,
      caller_name,
      email,
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
    SELECT
      next_ticket_id.id,
      'BP-HC-' || EXTRACT(YEAR FROM now())::text || '-' || LPAD(next_ticket_id.id::text, 4, '0'),
      $1,$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11,$12,$13
    FROM next_ticket_id
    RETURNING id, ticket_id, urgency, status, created_at
    `,
    [
      data.channel,
      data.caller_phone,
      data.caller_name,
      data.email,
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

  const inserted = result.rows[0];

  const ticket: TicketRow = {
    id: inserted.id,
    ticket_id: inserted.ticket_id,
    channel: data.channel,
    caller_phone: data.caller_phone,
    caller_name: data.caller_name,
    email: data.email,
    service_address: data.service_address,
    home_or_business: data.home_or_business,
    issue_type: data.issue_type,
    urgency: inserted.urgency,
    status: inserted.status,
    source: data.source,
    preferred_contact_method: data.preferred_contact_method,
    language: data.language,
    summary: data.summary,
    raw_payload: data.raw_payload,
    created_at: inserted.created_at,
  };

  app.log.info(
    {
      id: ticket.id,
      ticket_id: ticket.ticket_id,
      urgency: ticket.urgency,
      status: ticket.status,
      createdAt: ticket.created_at,
      route: getRouteForTicket(ticket, data.source),
    },
    "Ticket created"
  );

  try {
    await sendConfirmationSms(ticket.caller_phone, ticket.urgency, ticket.source);
  } catch (err: any) {
    app.log.error(
      {
        message: err?.message,
        code: err?.code,
        status: err?.status,
        moreInfo: err?.moreInfo,
        ticket_id: ticket.ticket_id,
      },
      "SMS send failed"
    );
  }

  try {
    await sendTicketToN8n(ticket);
  } catch (err: any) {
    app.log.error(
      {
        message: err?.message,
        ticket_id: ticket.ticket_id,
      },
      "N8N sync failed after ticket creation"
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
      hasN8nWebhook,
    },
    "Startup configuration"
  );

  app.get("/health", async () => {
    const db = await pool.query("SELECT now() AS now");
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
      urgency: "urgent",
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
