# Sub-processors

> **Status: DRAFT — pending review by qualified legal counsel. Not yet in effect.**
> Version: `draft-2026-06-23` · Effective date: `[EFFECTIVE DATE]`
>
> **Placeholders** in `[BRACKETS]` are values the operators must confirm before this
> page goes live. They are intentionally not filled in.

---

This page lists the third-party sub-processors that process personal data on behalf of
the **hosted Piyaz service at `app.piyaz.ai`**. It matches the sub-processor section of
our [Privacy Policy](/privacy). If you self-host Piyaz, this page does not apply to your
deployment: you are the data controller for your own instance.

## Current sub-processors

| Sub-processor | Processing purpose | Data region |
| --- | --- | --- |
| **Neon** (Neon Inc.) | Managed PostgreSQL database. | AWS `eu-central-1` (Frankfurt, Germany) |
| **Amazon Web Services (AWS)** | Underlying cloud infrastructure for the Neon database. | Frankfurt region (EU) |
| **Cloudflare, Inc.** | Application hosting (Workers), CDN, DNS, DDoS/WAF security, edge caching (KV/R2/D1), rate-limiting, and operational logging. | Global edge network |

## Changes to our sub-processors

Under **Article 28(2) GDPR**, B2B controllers who process personal data through Piyaz
receive advance notice before we add or replace a sub-processor, so they can object.

To subscribe to sub-processor change notices, email **privacy@piyaz.ai** with the
subject line **"Subscribe: sub-processor changes"**. Subscribed controllers receive at
least `[NOTICE PERIOD]` days' advance notice before a new or replacement sub-processor
begins processing personal data.
