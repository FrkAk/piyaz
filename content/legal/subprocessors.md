# Sub-processors

Last updated: July 14, 2026

---

This page lists the third-party sub-processors that process personal data on behalf of
the **hosted Piyaz service at `app.piyaz.ai`**. It matches the sub-processor section of
our [Privacy Policy](/privacy). If you self-host Piyaz, this page does not apply to your
deployment: you are the data controller for your own instance.

## Current sub-processors

| Sub-processor | Processing purpose | Data categories | Data region | Transfer mechanism |
| --- | --- | --- | --- | --- |
| **Neon, LLC** (a Databricks company, US) | Managed PostgreSQL database. | All service data at rest: account, workspace content, technical and session data, acceptance records. | AWS `eu-central-1` (Frankfurt, Germany) | EU SCCs; EU-US Data Privacy Framework |
| **Amazon Web Services (AWS)** (US) | Underlying cloud infrastructure for the Neon database. | The same data at rest, as Neon's hosting provider. | Frankfurt region (EU) | EU SCCs; EU-US Data Privacy Framework |
| **Cloudflare, Inc.** (US) | Application hosting (Workers), CDN, DNS, DDoS/WAF security, edge caching (KV/R2/D1), rate-limiting, operational logging, and transactional email delivery (Email Sending). | Technical and session data; all service data transiently in processing; recipient email addresses and transactional message content. | Global edge network | EU SCCs; EU-US Data Privacy Framework |

Transactional email (such as account and team notifications) is delivered through
Cloudflare's Email Sending service, covered by the Cloudflare entry above. Any
additional email provider will be added to this list through the change process below
before it processes personal data.

Coding agents, harnesses, and other tools you connect to your workspace are not
sub-processors: they act on your instructions and receive data at your direction. See
the [Privacy Policy](/privacy) ("Agents and connected tools") and the
[DPA](/dpa).

## Changes to our sub-processors

Under **Article 28(2) GDPR**, B2B controllers who process personal data through Piyaz
receive advance notice before we add or replace a sub-processor, so they can object.

To subscribe to sub-processor change notices, email **privacy@piyaz.ai** with the
subject line **"Subscribe: sub-processor changes"**. Subscribed controllers receive at
least **30 days'** advance notice before a new or replacement sub-processor begins
processing personal data.
