# Data Processing Agreement

Last updated: July 12, 2026

---

This Data Processing Agreement ("DPA") forms part of the agreement between the
customer organization whose owner accepts it in the team settings (the
**controller**) and Piyaz, the team operating the **hosted Piyaz service at
`app.piyaz.ai`** (the **processor**; the operating entity is in formation, see the
[Legal Notice](/impressum)). It governs the processing of personal data that the
controller places into Piyaz workspaces, under **Article 28 GDPR**. If you
self-host Piyaz, this DPA does not apply to your deployment: you are the
controller and the processor for your own instance. A revised version naming the
operating entity as the contracting processor will be offered once that entity is
established.

## Definitions

"Controller", "processor", "personal data", "processing", "data subject",
"sub-processor", and "personal data breach" have the meanings given in the GDPR.
"GDPR" means Regulation (EU) 2016/679. The subject matter, duration, nature and
purpose of processing, and the categories of data subjects and personal data are
set out in **Annex I**.

## Processor obligations

The processor processes personal data only on the controller's documented
instructions (the service agreement, these terms, and the controller's use of the
service settings), ensures personnel are bound by confidentiality, and implements
the technical and organizational measures in **Annex II**. Taking into
account the nature of processing and the information available to it, the
processor assists the controller with data-subject requests and with the
controller's obligations under **Articles 32 to 36 GDPR** (security,
personal-data-breach notification, data protection impact assessments, and prior
consultation). The processor deletes personal data at the end of processing
within the retention windows in **Annex I** (export is available to the controller
at any time before deletion).

The processor immediately informs the controller if, in its opinion, an
instruction from the controller infringes the GDPR or other applicable
data-protection law.

## Sub-processors

The controller authorizes the processor to engage the sub-processors listed on the
[sub-processor list](/subprocessors). That page names each sub-processor, its
processing purpose, its data region, and its transfer mechanism, and is
incorporated into this DPA by reference.

Agents, harnesses, and other tools that the controller or its users connect to the
Service act on the controller's instructions and receive data at the controller's
direction; they are recipients chosen by the controller, not sub-processors engaged
by the processor, and the processor has no access to or influence over their
behavior.

### Changes to sub-processors

Under **Article 28(2) GDPR**, the controller receives advance notice before the
processor adds or replaces a sub-processor, so the controller can object. To
subscribe to sub-processor change notices, email **privacy@piyaz.ai** with the
subject line **"Subscribe: sub-processor changes"**. Subscribed controllers
receive at least **30 days'** advance notice before a new or replacement
sub-processor begins processing personal data.

## International transfers

Personal data is stored at rest in the EU (AWS `eu-central-1`, Frankfurt).
Application compute runs on Cloudflare's global edge network, so transient
processing may occur outside the European Economic Area. Where personal data is
transferred outside the EEA, the transfer relies on the sub-processor's Data
Processing Agreement incorporating the **EU Standard Contractual Clauses**, with
the sub-processor's **EU-US Data Privacy Framework** certification as an
additional safeguard.

## Breach notification

The processor notifies the controller without undue delay after becoming aware of
a personal-data breach affecting the controller's data, with the information
required by **Article 33(3) GDPR** as it becomes available, so the controller can
meet its own notification duties.

## Audit

The processor makes available the information reasonably necessary to demonstrate
compliance with Article 28. The controller may request an audit in writing to
**privacy@piyaz.ai** no more than once per year; audits are conducted with
reasonable notice, during business hours, without disrupting the service, and
subject to confidentiality.

## Updates to this agreement

The processor may update this DPA only where the update is required to comply
with applicable law, regulation, a court order, or guidance issued by a
supervisory authority, or where the update is commercially reasonable and does
not reduce the security of the Service, does not expand the scope of or remove
restrictions on the processor's processing of personal data, and does not
otherwise have a material adverse impact on the controller's rights under this
DPA.

The current version is always available at [/dpa](/dpa), and the date at the top
reflects it. Updates are announced in the team settings of the Service. The
controller's continued use of the Service for a team after the update date
constitutes acceptance of the updated DPA for that team. A change that would
materially reduce the protections of this DPA takes effect for an existing team
only after a team owner expressly re-accepts it; changes to the sub-processor
list follow the notice and objection process in the Sub-processors section.

## Liability and precedence

This DPA forms part of, and is subject to, the [Beta Terms of Service](/terms),
including their limitation of liability, which applies to the parties' obligations
under this DPA. If this DPA conflicts with the Beta Terms of Service on the
processing of personal data, this DPA prevails. Where the Standard Contractual
Clauses referenced above apply, they prevail over this DPA to the extent of any
conflict.

## Annex I: Details of processing

| Item | Detail |
| --- | --- |
| Subject matter | Hosting and processing of the personal data the controller's team places into its Piyaz workspaces (projects, tasks, notes, decisions, execution records), and the account data of its team members. |
| Duration | For the term of the underlying service agreement. On account or team deletion, data is removed within 30 days and backup copies are purged within 90 days, as described in the [Privacy Policy](/privacy). |
| Nature and purpose | Storage, retrieval, display, search, and transmission of workspace content solely to provide the project-management service to the controller. The processor does not use the data for its own purposes. |
| Categories of data subjects | The controller's team members, invitees, and any individuals referenced in workspace content the controller chooses to store. |
| Categories of personal data | Account and contact data (name, email address), technical and session data, and workspace content that may contain personal data. |
| Special categories | None. The controller must not place special-category data (Art. 9 GDPR) into workspace content. |
| Frequency of transfer | On a continuous basis for the term of the service agreement. |

## Annex II: Technical and organizational measures

The processor implements the measures described in the [Privacy Policy](/privacy),
section "How we protect your data": encryption in transit (TLS), provider
encryption at rest, row-level security for tenant isolation, salted password
hashing, short-lived and revocable sessions, restricted production access, and
rate-limiting of API surfaces.
