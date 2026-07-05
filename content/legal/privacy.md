# Privacy Policy

> **Status: DRAFT — pending review by qualified legal counsel. Not yet in effect.**
> Version: `draft-2026-06-23` · Effective date: `[EFFECTIVE DATE]`
>
> **Scope:** This Privacy Policy governs the **hosted Piyaz service at `app.piyaz.ai`**,
> operated by the Piyaz founders. **If you self-host Piyaz, this document does not
> apply to your deployment** — you are the data controller for your own instance and
> must provide your own privacy policy. See `docs/legal/README.md`.
>
> **Placeholders** in `[BRACKETS]` are values the operators must confirm before this
> policy goes live. They are intentionally not filled in.

---

## Who we are (data controller)

Piyaz ("Piyaz", "we", "us", "our") is currently operated by its founders pending
incorporation. Because the founders jointly decide why and how your personal data is
processed, they act as **joint controllers** under Article 26 GDPR. The responsible
primary contact is:

- **Furkan Akbulutlar** (primary data-protection contact)
- Co-founders: `[CO-FOUNDER NAME 2]`, `[CO-FOUNDER NAME 3]`
- Postal address: `[POSTAL ADDRESS, GERMANY]`
- Email: **privacy@piyaz.ai**

We have not appointed a Data Protection Officer (a DPO is not mandatory for an
operation of our current size under Art. 37 GDPR). This policy will be updated to name
the incorporated entity once it is formed.

## What data we collect

We collect the following categories of personal data:

- **Account data** — your name and email address.
- **Credentials** — a salted, hashed password (we never store your password in plain text). If you sign in with a third-party provider in future, we receive your basic profile from that provider instead.
- **Profile data** — an optional avatar image URL.
- **Technical and session data** — your IP address, browser user-agent, session identifiers, and timestamps.
- **Workspace data** — team/organization names, membership roles, and the email addresses of people you invite.
- **Integration data** — metadata about coding-agent clients you connect over MCP/OAuth (client name, identifiers, and the access you grant them).
- **Content you create** — projects, tasks, decisions, execution records, and related notes. This content may contain personal data if you choose to put it there.
- **Acceptance records** — a record that you accepted the Beta Terms and acknowledged this Privacy Policy, including the document version, timestamp, and IP address.

We do **not** collect special-category data (Art. 9 GDPR) and ask that you do not place it in your workspace content.

## How we collect your data

We collect personal data when you:

- register for and use an account;
- create teams, invite collaborators, and produce workspace content;
- connect a coding agent or other client over MCP/OAuth;
- interact with the service, which automatically records technical and session data needed to operate and secure it.

## How we use your data, and our legal basis

| Purpose | Legal basis (GDPR Art. 6) |
| --- | --- |
| Create and operate your account; provide the service | **6(1)(b)** performance of a contract |
| Authenticate you; keep the service secure; prevent abuse and rate-limit | **6(1)(f)** legitimate interests (security, integrity) |
| Operational logging, diagnostics, and reliability | **6(1)(f)** legitimate interests (reliability), data-minimized |
| Keep records that you accepted our terms | **6(1)(c)** legal obligation / **6(1)(f)** legitimate interest (evidence) |
| Send service and transactional messages | **6(1)(b)** / **6(1)(f)** |
| Comply with the law and respond to lawful requests | **6(1)(c)** legal obligation |

We do **not** use your data for advertising, and we do **not** sell it. We currently send
**no marketing email**. If that ever changes, we will ask for your separate, opt-in
consent (Art. 6(1)(a)) first.

We do **not** carry out automated decision-making or profiling that produces legal or
similarly significant effects on you (Art. 22 GDPR).

## How we store your data and who processes it

Your data is stored in the **European Union**. We use the following sub-processors:

- **Neon** (Neon Inc.) — managed PostgreSQL database. Your data is stored in the **AWS `eu-central-1` (Frankfurt, Germany)** region.
- **Amazon Web Services (AWS)** — underlying cloud infrastructure for the Neon database, Frankfurt region (EU).
- **Cloudflare, Inc.** — application hosting (Workers), CDN, DNS, DDoS/WAF security, edge caching (KV/R2/D1), rate-limiting, and operational logging across its global edge network.

A current sub-processor list is maintained at `[SUB-PROCESSOR LIST URL]`.

### International transfers

Your data is primarily stored and processed in the EU. Some sub-processors
(Neon Inc. and Cloudflare, Inc.) are headquartered in the United States and may access
data from outside the European Economic Area for support and operational purposes. Such
transfers are governed by the **EU Standard Contractual Clauses (SCCs)** and the
providers' Data Processing Agreements. `[CONFIRM DPAs/SCCs ARE IN PLACE WITH EACH SUB-PROCESSOR.]`

## How long we keep your data

- **Account and workspace data** — for as long as your account is active. After you delete your account, data is removed within `[30 DAYS]`, and residual copies in backups are purged within `[90 DAYS]`.
- **Session records** — expire automatically after **7 days**.
- **Acceptance records** — retained for the life of your account plus `[RETENTION PERIOD]` to evidence your agreement.
- **Operational logs and traces** — retained for `[LOG RETENTION PERIOD]` and then deleted or anonymized.

`[CONFIRM ALL RETENTION PERIODS WITH COUNSEL.]`

## Your data protection rights

Under the GDPR you have the right to:

- **Access** — request a copy of the personal data we hold about you.
- **Rectification** — have inaccurate or incomplete data corrected.
- **Erasure** — ask us to delete your personal data ("right to be forgotten").
- **Restriction** — ask us to limit how we process your data.
- **Data portability** — receive your data in a structured, machine-readable format.
- **Object** — object to processing based on our legitimate interests.
- **Withdraw consent** — where we rely on consent, withdraw it at any time (this does not affect prior processing).

To exercise any of these rights, email **privacy@piyaz.ai**. We will respond within
**one month** (Art. 12(3) GDPR). There is no charge for a reasonable request.

## Cookies

We use only **strictly necessary cookies** required to operate the service — chiefly the
authentication session cookie, which is `httpOnly`, `SameSite=Lax`, and `Secure` in
production. We do **not** use analytics, advertising, or tracking cookies. Because our
cookies are strictly necessary, no cookie-consent banner is required under the ePrivacy
Directive. `[CONFIRM no analytics/tracking cookies ship before launch.]`

## Children

The service is not directed to children under 16, and we do not knowingly collect their
personal data. If you believe a child has provided us data, contact **privacy@piyaz.ai**
and we will delete it.

## Privacy policies of other websites

The service may link to third-party sites (for example, a connected coding-agent
vendor). This policy applies only to Piyaz; we are not responsible for the privacy
practices of other sites.

## Changes to this policy

We keep this policy under review and may update it. The version identifier and effective
date at the top reflect the current version. We will notify you of material changes
`[in-app and/or by email]`, and where required we will ask you to re-accept.

## How to contact us

Questions about this policy or your data: **privacy@piyaz.ai**.

## How to contact the supervisory authority

If you believe we have not handled your data lawfully, you have the right to lodge a
complaint with a data protection supervisory authority. In Germany this is the data
protection authority of the relevant federal state (`[LANDESDATENSCHUTZBEHÖRDE]`) or the
Federal Commissioner for Data Protection and Freedom of Information (BfDI).
`[CONFIRM the competent lead authority based on the controllers' place of establishment.]`
