# Sub-processors

> **Status: preliminary beta version, not yet reviewed by legal counsel.**
> Version: `draft-2026-07-10` · Effective while the service is in beta.

---

This page lists the third-party sub-processors that process personal data on behalf of
the **hosted Piyaz service at `app.piyaz.ai`**. It matches the sub-processor section of
our [Privacy Policy](/privacy). If you self-host Piyaz, this page does not apply to your
deployment: you are the data controller for your own instance.

## Current sub-processors

| Sub-processor | Processing purpose | Data region | Transfer mechanism |
| --- | --- | --- | --- |
| **Neon, LLC** (a Databricks company, US) | Managed PostgreSQL database. | AWS `eu-central-1` (Frankfurt, Germany) | EU SCCs; EU-US Data Privacy Framework |
| **Amazon Web Services (AWS)** (US) | Underlying cloud infrastructure for the Neon database. | Frankfurt region (EU) | EU SCCs; EU-US Data Privacy Framework |
| **Cloudflare, Inc.** (US) | Application hosting (Workers), CDN, DNS, DDoS/WAF security, edge caching (KV/R2/D1), rate-limiting, and operational logging. | Global edge network | EU SCCs; EU-US Data Privacy Framework |

A transactional email provider is not yet engaged. Before one begins processing any
personal data (such as recipient email addresses), it will be added to this list
through the change process below.

## Changes to our sub-processors

Under **Article 28(2) GDPR**, B2B controllers who process personal data through Piyaz
receive advance notice before we add or replace a sub-processor, so they can object.

To subscribe to sub-processor change notices, email **privacy@piyaz.ai** with the
subject line **"Subscribe: sub-processor changes"**. Subscribed controllers receive at
least **30 days'** advance notice before a new or replacement sub-processor begins
processing personal data.
