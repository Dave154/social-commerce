# Automated Multi-Tenant Social Commerce SaaS 
## Architecture & Implementation Master Plan

**Target Audience:** Agentic AI / Development Assistant
**Project Goal:** Build a multi-tenant backend system that automates customer service, negotiation, and checkout for social media vendors (Instagram, WhatsApp, TikTok) using LLMs (Retrieval-Augmented Generation) and programmatic payments.

---

## 1. Current Tech Stack (Updated)
*Note: The project initially explored Hono + Cloudflare Workers but pivoted due to Windows Node.js v24 `libuv`/`async.c` local environment bugs.*

* **Backend Framework:** Fastify (Node.js) - Chosen for speed, high-volume webhook handling, and built-in JSON schema validation.
* **Database:** Supabase (PostgreSQL with `pgvector` extension) - Handles relational data, Row Level Security (RLS) for multi-tenancy, and AI memory (embeddings) in a single unified system.
* **Hosting / Deployment:** Vercel (Zero-config Serverless deployment for Fastify).
* **AI Engine:** OpenAI API (`text-embedding-ada-002` for vectorization, `gpt-4o` / `gpt-3.5-turbo` for chat generation).
* **Payment Gateway:** Paystack (or Flutterwave) for dynamic checkout links.
* **Social APIs:** Meta Graph API (Instagram DMs), WhatsApp Cloud API, TikTok Business Messaging API.

---

## 2. Database Schema (Supabase)
The system relies on a single centralized database utilizing `vendor_id` foreign keys to ensure strict data separation between different businesses.

### A. `vendors` (Tenant Registry)
Stores the business profiles, unique API keys, and custom AI personas.
* `id` (UUID, Primary Key)
* `business_name` (Text)
* `meta_access_token` (Text)
* `paystack_secret_key` (Text)
* `tiktok_access_token` (Text) - *For future integration*
* `system_prompt` (Text) - *e.g., "You are a polite vendor for Bella Shoes..."*

### B. `products` (Vector / AI Memory Table)
Stores the chunked vendor catalogs and documents alongside their OpenAI embeddings.
* `id` (UUID, Primary Key)
* `vendor_id` (UUID, Foreign Key -> `vendors.id` ON DELETE CASCADE)
* `product_name` (Text)
* `price` (Numeric)
* `description` (Text)
* `embedding` (VECTOR(1536)) - *OpenAI generated vector array*

### C. `orders` (Automated Ledger)
Records successful checkouts.
* `id` (UUID, Primary Key)
* `vendor_id` (UUID, Foreign Key -> `vendors.id` ON DELETE CASCADE)
* `customer_phone` (Text)
* `product_purchased` (Text)
* `amount_paid` (Numeric)
* `payment_status` (Text)

---

## 3. Core Logic & Data Flow

### Phase 1: Onboarding & RAG Preparation
1.  Vendor provides catalog/FAQs.
2.  Data is chunked into logical units (e.g., single product details).
3.  Chunks are sent to OpenAI Embedding API.
4.  Text and returned 1536-dimensional vectors are stored in the `products` table, tagged with the specific `vendor_id`.

### Phase 2: The Chat Workflow (Incoming Webhook)
1.  **Trigger:** Customer sends a DM on IG/WhatsApp.
2.  **Routing:** Webhook hits Fastify server `POST /webhook`.
3.  **Context Extraction:** System identifies the target `vendor_id` based on the receiving phone number/account.
4.  **Vector Search:** Server embeds the customer's query and performs a cosine similarity search against the `products` table, filtered strictly by `vendor_id`.
5.  **LLM Generation:** Server bundles the top vector search results (product context) + the vendor's `system_prompt` + the conversation history, and sends it to ChatGPT.
6.  **Response:** AI crafts a human-like reply. If intent is to purchase, AI triggers the payment gateway logic. Server sends the reply back to the user via Meta APIs.

### Phase 3: The Payment Workflow
1.  **Link Generation:** Fastify generates a dynamic Paystack checkout link for the specific cart amount.
2.  **Payment Webhook:** Customer pays -> Paystack fires a webhook to a dedicated endpoint (e.g., `POST /paystack-webhook`).
3.  **Fulfillment:** Fastify verifies the payment, logs the transaction in the `orders` table, and triggers a final API call to send a WhatsApp receipt to the customer and dispatch instructions to the vendor.

---

## 4. Platform-Specific Integration Details

### Meta (Instagram & WhatsApp)
* **Verification:** Requires a simple `GET /webhook` route that parses `hub.mode`, `hub.verify_token`, and returns the `hub.challenge` raw string.
* **Timeouts:** Responds to webhooks immediately with `200 OK` (e.g., `EVENT_RECEIVED`) before processing the AI logic to prevent Meta from retrying and flooding the server.

### TikTok (Omnichannel Expansion)
* **Security Signature:** Unlike Meta, TikTok requires parsing an `HMAC-SHA256` signature in the `Authorization` header of the webhook. Requires specific Fastify middleware.
* **The 48/10 Rule:** TikTok enforces a strict 48-hour window and a maximum of 10 AI messages per user reply. The logic must track message counts to prevent API bans.
* **Strictly Inbound:** The bot can never initiate a conversation on TikTok.

---

## 5. Deployment Pipeline
1.  **Local Environment:** Standard Node.js (`node server.js`) using `.env` for `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2.  **Tunneling (Optional):** Using `ngrok` if local webhook testing is required.
3.  **Production:** Deployed via Vercel CLI (`vercel --prod`). Environment variables must be explicitly set in the Vercel Dashboard prior to deployment.