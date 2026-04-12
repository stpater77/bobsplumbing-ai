"use client";

import { useState } from "react";

type FormState = {
  caller_name: string;
  caller_phone: string;
  service_address: string;
  home_or_business: "home" | "business";
  issue_type: string;
  urgency: "normal" | "emergency";
  preferred_contact_method: "sms" | "call" | "email";
  language: "en" | "es";
  summary: string;
};

const API_URL = "https://bobsplumbing-ai-production.up.railway.app/intake/form";

const initialState: FormState = {
  caller_name: "",
  caller_phone: "",
  service_address: "",
  home_or_business: "home",
  issue_type: "",
  urgency: "normal",
  preferred_contact_method: "sms",
  language: "en",
  summary: "",
};

export default function HomePage() {
  const [form, setForm] = useState<FormState>(initialState);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult("");
    setError("");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.message || "Submission failed.");
      }

      setResult(
        `Request submitted successfully. Ticket ID: ${data?.ticket?.id ?? "N/A"} | Route: ${data?.route ?? "unknown"}`
      );
      setForm(initialState);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight">Bob&apos;s Plumbing</h1>
          <p className="mt-2 text-slate-300">Service Request Intake Form</p>
          <p className="mt-1 text-sm text-slate-400">
            This form feeds the same routing system as the AI dispatcher.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium">Name</label>
              <input
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.caller_name}
                onChange={(e) => update("caller_name", e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Phone</label>
              <input
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.caller_phone}
                onChange={(e) => update("caller_phone", e.target.value)}
                placeholder="+15551234567"
                required
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">Service Address</label>
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
              value={form.service_address}
              onChange={(e) => update("service_address", e.target.value)}
              required
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium">Home or Business</label>
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.home_or_business}
                onChange={(e) =>
                  update("home_or_business", e.target.value as "home" | "business")
                }
              >
                <option value="home">Home</option>
                <option value="business">Business</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Preferred Contact Method</label>
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.preferred_contact_method}
                onChange={(e) =>
                  update(
                    "preferred_contact_method",
                    e.target.value as "sms" | "call" | "email"
                  )
                }
              >
                <option value="sms">SMS</option>
                <option value="call">Call</option>
                <option value="email">Email</option>
              </select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium">Language</label>
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.language}
                onChange={(e) => update("language", e.target.value as "en" | "es")}
              >
                <option value="en">English</option>
                <option value="es">Spanish</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Emergency?</label>
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
                value={form.urgency}
                onChange={(e) =>
                  update("urgency", e.target.value as "normal" | "emergency")
                }
              >
                <option value="normal">Normal</option>
                <option value="emergency">Emergency</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">Issue Type</label>
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
              value={form.issue_type}
              onChange={(e) => update("issue_type", e.target.value)}
              placeholder="e.g. sewer backup, water heater, leak, clog"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">Description</label>
            <textarea
              className="min-h-32 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none"
              value={form.summary}
              onChange={(e) => update("summary", e.target.value)}
              placeholder="Describe the plumbing problem."
              required
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit Request"}
          </button>

          {result && (
            <div className="rounded-lg border border-green-700 bg-green-950 px-4 py-3 text-green-200">
              {result}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-700 bg-red-950 px-4 py-3 text-red-200">
              {error}
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
