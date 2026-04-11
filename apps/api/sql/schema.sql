create table if not exists tickets (
  id bigserial primary key,
  channel text not null default 'voice',
  caller_phone text,
  caller_name text,
  service_address text,
  home_or_business text default 'home',
  issue_type text,
  urgency text not null default 'normal',
  status text not null default 'new',
  source text not null default 'inbound',
  preferred_contact_method text default 'sms',
  language text default 'en',
  summary text,
  raw_payload jsonb,
  created_at timestamptz default now()
);

create table if not exists escalations (
  id bigserial primary key,
  ticket_id bigint references tickets(id) on delete cascade,
  level_no int not null,
  contact_name text,
  contact_phone text,
  outcome text,
  created_at timestamptz default now()
);
