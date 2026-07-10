# Privacy Policy

> **Status: preliminary beta version, not yet reviewed by legal counsel.**
> Version: `draft-2026-07-10` · Effective while the Service is in beta.
>
> **Scope:** This Privacy Policy governs the **hosted Piyaz service at `app.piyaz.ai`**,
> operated by the Piyaz team. **If you self-host Piyaz, this document does not
> apply to your deployment**: you are the data controller for your own instance and
> must provide your own privacy policy.

---

## Who we are (data controller)

Piyaz ("Piyaz", "we", "us", "our") is operated by its team. A formal operating entity
has not yet been established; the team members jointly decide why and how your personal
data is processed and act as **joint controllers** under Article 26 GDPR. Contact for
all data-protection matters:

- Email: **privacy@piyaz.ai**

We have not appointed a Data Protection Officer (a DPO is not mandatory for an
operation of our current size under Art. 37 GDPR). This policy is a preliminary beta
version and will be updated to name the operating entity and its full contact details
once it is formed (see the [Legal Notice](/impressum)).

## What data we collect

We collect the following categories of personal data:

- **Account data**: your name and email address.
- **Credentials**: a salted, hashed password (we never store your password in plain text). If you sign in with a third-party provider in future, we receive your basic profile from that provider instead.
- **Profile data**: an optional avatar image URL.
- **Technical and session data**: your IP address, browser user-agent, session identifiers, and timestamps.
- **Workspace data**: team/organization names, membership roles, and the email addresses of people you invite.
- **Integration data**: metadata about coding-agent clients you connect over MCP/OAuth (client name, identifiers, and the access you grant them).
- **Content you create**: projects, tasks, decisions, execution records, and related notes. This content may contain personal data if you choose to put it there.
- **Acceptance records**: a record that you accepted the Beta Terms and acknowledged this Privacy Policy, including the document version, timestamp, IP address, and browser user-agent.

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

- **Neon** (Neon, LLC, a Databricks company): managed PostgreSQL database. Your data is stored in the **AWS `eu-central-1` (Frankfurt, Germany)** region.
- **Amazon Web Services (AWS)**: underlying cloud infrastructure for the Neon database, Frankfurt region (EU).
- **Cloudflare, Inc.**: application hosting (Workers), CDN, DNS, DDoS/WAF security, edge caching (KV/R2/D1), rate-limiting, and operational logging across its global edge network.

A current sub-processor list is maintained at `https://app.piyaz.ai/subprocessors`.

### International transfers

Two things are true at once, and we state both plainly:

- **Data at rest** lives in the EU: the database runs in AWS `eu-central-1`
  (Frankfurt, Germany).
- **Compute is global**: the application runs on Cloudflare Workers, a global edge
  network, so requests (including TLS termination) are processed at the Cloudflare
  location nearest to you, which may be outside the European Economic Area.

Our US-headquartered sub-processors (Neon, LLC and Cloudflare, Inc.) may also access
data from outside the EEA for support and operational purposes. All such transfers are
governed by each provider's Data Processing Agreement incorporating the **EU Standard
Contractual Clauses (SCCs)**, with the provider's certification under the **EU-US Data
Privacy Framework** as an additional safeguard.

## How we protect your data

We take voluntary, best-effort technical and organizational measures appropriate to the
risk and the state of the art:

- all traffic is encrypted in transit (HTTPS/TLS);
- data at rest is protected by the storage provider's encryption (Neon/AWS);
- tenant isolation is enforced inside the database itself with row-level security, so
  one team's data is not readable from another team's context;
- passwords are stored only as salted hashes; sessions are short-lived and revocable;
- access to production systems is restricted, and API surfaces are rate-limited.

We do not currently apply application-level (field) encryption on top of the provider's
storage encryption. No internet service can guarantee absolute security, and we make no
such guarantee; we commit to maintaining and improving these measures as the service
grows.

## How long we keep your data

- **Account and workspace data**: for as long as your account is active. After you delete your account, data is removed within **30 days**, and residual copies in backups are purged within **90 days**.
- **Session records**: expire automatically after **7 days**.
- **Acceptance records**: retained for the life of your account plus **3 years** to evidence your agreement.
- **Operational logs and traces**: retained for up to **90 days** and then deleted or anonymized.

## Your data protection rights

Under the GDPR you have the right to:

- **Access**: request a copy of the personal data we hold about you.
- **Rectification**: have inaccurate or incomplete data corrected.
- **Erasure**: ask us to delete your personal data ("right to be forgotten").
- **Restriction**: ask us to limit how we process your data.
- **Data portability**: receive your data in a structured, machine-readable format.
- **Object**: object to processing based on our legitimate interests.
- **Withdraw consent**: where we rely on consent, withdraw it at any time (this does not affect prior processing).

To exercise any of these rights, email **privacy@piyaz.ai**. We will respond within
**one month** (Art. 12(3) GDPR). There is no charge for a reasonable request.

## Cookies

We use only **strictly necessary cookies** required to operate the service, chiefly the
authentication session cookie, which is `httpOnly`, `SameSite=Lax`, and `Secure` in
production. We do **not** use analytics, advertising, or tracking cookies. Because our
cookies are strictly necessary, no cookie-consent banner is required under the ePrivacy
Directive.

## Analytics we may add later

Today the service ships **no analytics**. To keep the service reliable we may later
introduce tooling for **performance monitoring, error and crash tracking, and
aggregated usage reporting**. When we do, we will prefer privacy-preserving,
server-side, aggregated approaches under our legitimate interest in running a reliable
service. If any such tool stores or reads information on your device or sends data to a
third-party analytics processor, we will **update this policy first and ask for your
consent where required** before enabling it.

## Children

The service is not directed to children under 16, and we do not knowingly collect their
personal data. If you believe a child has provided us data, contact **privacy@piyaz.ai**
and we will delete it.

## Privacy policies of other websites

The service may link to third-party sites (for example, a connected coding-agent
vendor). This policy applies only to Piyaz; we are not responsible for the privacy
practices of other sites.

## Changes to this policy

We keep this policy under review and may update it. The version identifier at the top
reflects the current version. We will notify you of material changes in-app or by
email, and where required we will ask you to re-accept.

## How to contact us

Questions about this policy or your data: **privacy@piyaz.ai**.

## How to contact the supervisory authority

If you believe we have not handled your data lawfully, you have the right to lodge a
complaint with a data protection supervisory authority, in particular in the EU member
state of your habitual residence, your place of work, or the place of the alleged
infringement (Art. 77 GDPR).
