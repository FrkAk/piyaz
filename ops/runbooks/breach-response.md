# Personal-Data Breach Response Runbook

> **Status: DRAFT, pending review by qualified legal counsel. Not yet in effect.**
> Version: `draft-2026-07-06`
>
> **Scope:** Internal incident-response process for **personal-data breaches** under
> the GDPR (Arts. 33 and 34). This is an operational runbook for the on-call
> engineer and incident responders, not a public-facing policy. Every real internal
> value (on-call names, escalation channels, authority portal, establishment address)
> is a `[PLACEHOLDER]` until confirmed. The legal notification templates below must be
> sanity-checked by qualified counsel before this runbook is treated as in effect.

A **personal-data breach** is a breach of security leading to the accidental or
unlawful destruction, loss, alteration, unauthorised disclosure of, or access to,
personal data (Art. 4(12)): that is, a loss of **confidentiality**, **integrity**, or
**availability** of personal data. Not every security incident is a personal-data
breach, and not every personal-data breach triggers notification; this runbook drives
that decision and records it.

---

## 1. Scope and roles

This runbook applies the moment any responder suspects that personal data may have been
destroyed, lost, altered, or exposed. When in doubt, open an incident: an event that
turns out not to be a breach is cheap to close; an unlogged breach is not.

**Who can declare an incident.** Any engineer, on-call responder, or staff member who
suspects a personal-data breach can and must declare one. Declaring is not an
accusation and does not require certainty; it starts the clock and the process.

Roles engaged once an incident is declared:

| Role | Responsibility |
| --- | --- |
| **Incident lead** | Owns the incident end to end: coordinates responders, drives the timeline, makes the notify / no-notify call with the privacy owner, and signs off the breach-log entry. `[PLACEHOLDER: on-call incident lead / escalation rota]` |
| **Privacy / DPO owner** | Owns the legal assessment: risk to data subjects, Art. 33/34 obligations, authority contact, and template sign-off. Confirms whether Piyaz acts as controller or processor for the affected data. `[PLACEHOLDER: privacy/DPO owner]` |
| **On-call engineer** | Contains and remediates: stops ongoing exposure, preserves evidence and logs, scopes which data and how many data subjects are affected. `[PLACEHOLDER: on-call engineer rota]` |
| **Comms** | Owns external and user-facing messaging once notification is decided: sends Art. 34 notices, handles inbound questions, coordinates any public statement. `[PLACEHOLDER: comms owner]` |

**Where the incident lives.** Declare and coordinate the incident in
`[PLACEHOLDER: internal incident channel]`. Escalate to `[PLACEHOLDER: escalation
path / leadership on-call]` when the assessment points to high risk, a missed 72-hour
window, or a cross-border or processor-chain complication.

**Awareness clock.** "Awareness" means the point at which Piyaz has a reasonable degree
of certainty that a security incident has occurred and compromised personal data. Record
the awareness timestamp immediately in the breach log (§6); the 72-hour Art. 33 window
runs from this moment, not from when the breach first happened.

---

## 2. Detection and risk assessment

### 2.1 Confirm it is a personal-data breach

Establish, and record in the breach log, which of the three security properties failed:

- **Confidentiality**: personal data was disclosed to, or accessed by, an unauthorised
  party (leaked export, exposed endpoint, mis-sent email, stolen credential).
- **Integrity**: personal data was altered without authorisation in a way that affects
  data subjects.
- **Availability**: personal data was lost or made inaccessible (deletion, ransomware,
  irrecoverable outage of the sole copy).

If none of these applies to personal data, it is not a personal-data breach under this
runbook; close it as a general security incident and note the reasoning. If any applies,
continue.

### 2.2 Assess likelihood and severity of risk to data subjects

Assess the **risk to the rights and freedoms of natural persons**, weighing both the
**likelihood** and the **severity** of harm. Consider:

- **Type of breach** (confidentiality vs integrity vs availability).
- **Nature, sensitivity, and volume** of the personal data (special-category data,
  credentials, financial data, and data that enables identity fraud weigh heaviest).
- **Ease of identifying** the affected data subjects from the exposed data.
- **Severity of consequences**: identity theft, fraud, financial loss, reputational
  damage, discrimination, or loss of confidentiality of data protected by professional
  secrecy.
- **Special characteristics** of the data subjects (e.g. minors or vulnerable people)
  and of the controller.
- **Number of affected data subjects.**
- Whether the data was **encrypted, pseudonymised, or otherwise rendered unintelligible**
  to any unauthorised party, which can lower the residual risk.

### 2.3 The decision the assessment drives

The assessment yields one of three outcomes. Record the outcome and its rationale in the
breach log (§6) in every case, including no-notify.

| Assessed risk | Authority (Art. 33) | Data subjects (Art. 34) |
| --- | --- | --- |
| **Unlikely** to result in a risk to rights and freedoms | Not required, but document why (§6) | Not required |
| **Likely** to result in a risk | **Notify** the supervisory authority within 72h (§3) | Not required unless high risk |
| **High** risk to rights and freedoms | **Notify** the supervisory authority within 72h (§3) | **Notify** affected data subjects without undue delay (§4) |

If the assessment is not yet conclusive but a risk cannot be ruled out, treat it as
notifiable and proceed to §3; you can refine and, if justified, stand down, but you
cannot recover a missed 72-hour window.

---

## 3. Art. 33: Supervisory-authority notification (72 hours)

When the assessment (§2.3) concludes the breach is **likely to result in a risk** to the
rights and freedoms of natural persons, notify the competent supervisory authority
**without undue delay and, where feasible, not later than 72 hours after having become
aware of it** (Art. 33(1)). Where notification is not made within 72 hours, it must be
**accompanied by the reasons for the delay**, so notify anyway, late, and record the
delay reason (§6); a late notification is required, a skipped one is a violation.

### 3.1 Competent authority

The competent supervisory authority is the **German state Landesdatenschutzbehörde of
the controller's place of establishment**, via its online breach-notification portal and
contact path. The establishment address is not yet finalized (see PYZ-298), so the
authority and its portal remain `[PLACEHOLDER]` until confirmed.

The competent supervisory authority is framed as follows:

> In Germany this is the data protection authority of the relevant federal state
> (`[LANDESDATENSCHUTZBEHÖRDE]`) or the Federal Commissioner for Data Protection and
> Freedom of Information (BfDI).
> `[CONFIRM the competent lead authority based on the controllers' place of establishment.]`

- **Breach-notification portal:** `[PLACEHOLDER: online breach-notification portal URL of the competent Landesdatenschutzbehörde]`
- **Contact path:** `[PLACEHOLDER: authority contact / breach-notification email or hotline]`

**Cross-border processing (one-stop-shop).** Where processing is cross-border, the
Art. 55/56 one-stop-shop rules can move competence to a single **lead supervisory
authority** determined by the controller's main establishment. Do not hard-code this:
`[CONFIRM with counsel whether a one-stop-shop lead authority applies and, if so, which.]`

### 3.2 What the notification must contain

At minimum (Art. 33(3)), even where the notification is phased because full details are
not yet available:

- The **nature** of the breach, including, where possible, the categories and approximate
  number of data subjects and of personal-data records concerned.
- The **name and contact details** of the DPO or other contact point where more
  information can be obtained. `[PLACEHOLDER: DPO / contact point]`
- The **likely consequences** of the breach.
- The **measures taken or proposed** to address the breach and to mitigate its possible
  adverse effects.

If not all information is available within 72 hours, provide it **in phases without
undue further delay** (Art. 33(4)).

---

## 4. Art. 34: Affected-user notification and templates

When the breach is **likely to result in a high risk** to the rights and freedoms of
natural persons, communicate the breach to the affected data subjects **without undue
delay** (Art. 34(1)). The communication must be in **clear and plain language** and
describe the nature of the breach, and it must include at least the same contact point,
likely consequences, and measures as the Art. 33(3) notification (Art. 34(2)).

**Art. 34(3) exemptions: no user notification is required if:**

- The affected data was rendered **unintelligible** to unauthorised parties (e.g. strong
  encryption) so the high risk is unlikely to materialise; **or**
- **Subsequent measures** were taken that ensure the high risk is no longer likely to
  materialise; **or**
- It would involve **disproportionate effort**, in which case a **public communication**
  or equivalent measure informing data subjects in an equally effective manner is used
  instead.

Record which exemption (if any) was relied on, and the reasoning, in the breach log (§6).
The supervisory authority may still **require** communication to data subjects even where
Piyaz assessed it as not required (Art. 34(4)).

### 4.1 Template A: Direct notice to an affected user (high risk)

> **Subject: Important security notice about your Piyaz account**
>
> Hi `[FIRST NAME / "there"]`,
>
> We are writing to let you know about a security incident that affected some of your
> personal data held by Piyaz, and what we are doing about it.
>
> **What happened.** On `[DATE]`, we became aware that `[PLAIN-LANGUAGE DESCRIPTION OF
> THE BREACH: what happened and how]`.
>
> **What information was involved.** The incident involved `[CATEGORIES OF DATA, e.g.
> name, email address, ...]`. `[STATE CLEARLY whether passwords, payment data, or
> special-category data were involved, and whether any data was encrypted.]`
>
> **What this could mean for you.** `[LIKELY CONSEQUENCES in plain language.]`
>
> **What we have done.** `[MEASURES TAKEN to address the breach and mitigate harm.]`
>
> **What you can do.** `[RECOMMENDED ACTIONS, e.g. reset your password, watch for
> phishing, review account activity.]`
>
> **Questions.** If you have any questions, contact us at **privacy@piyaz.ai**. You also
> have the right to lodge a complaint with a data protection supervisory authority.
>
> We are sorry this happened and take the protection of your data seriously.
>
> - The Piyaz team

### 4.2 Template B: Public communication (used under the Art. 34(3)(c) disproportionate-effort route)

> **Security notice**
>
> On `[DATE]`, Piyaz became aware of a security incident affecting `[SCOPE / CATEGORIES
> OF DATA]`. `[PLAIN-LANGUAGE DESCRIPTION.]` We are contacting affected users where
> feasible; because direct contact of every affected person would involve
> disproportionate effort, we are also publishing this notice so that anyone affected can
> take steps to protect themselves.
>
> **If you may be affected:** `[RECOMMENDED PROTECTIVE ACTIONS.]`
>
> **Likely consequences:** `[LIKELY CONSEQUENCES.]`
>
> **What we have done:** `[MEASURES TAKEN.]`
>
> Questions: **privacy@piyaz.ai**. You have the right to lodge a complaint with a data
> protection supervisory authority.

---

## 5. Art. 33(2): Processor-to-controller notification

Notification direction depends on Piyaz's role for the affected data. Confirm the role in
§1 before acting.

- **Piyaz as controller.** Piyaz determines the purposes and means of the processing.
  Piyaz notifies the **supervisory authority** (§3) and, where high risk, the affected
  **data subjects** (§4).
- **Piyaz as processor.** Piyaz processes personal data on behalf of another controller.
  On becoming aware of a breach of that controller's data, Piyaz notifies **that
  controller without undue delay** (Art. 33(2)). Piyaz does **not** notify the
  supervisory authority directly for that data; the controller owns the Art. 33/34 calls.
  Provide the controller with the facts, scope, and measures they need to meet their own
  72-hour window.
  - **Controller contact:** `[PLACEHOLDER: controller notification contact per the
    data-processing agreement]`.

**Sub-processor breaches, up the chain.** If a breach originates with one of Piyaz's own
sub-processors, that sub-processor must notify Piyaz without undue delay under its
contract. Piyaz then propagates up the chain: where Piyaz is the controller, run §2–§4;
where Piyaz is a processor for another controller, notify that controller under
Art. 33(2). A breach never stops at the sub-processor; it flows up to whoever holds the
controller obligations.

---

## 6. Breach log (Art. 33(5) register)

Regardless of whether the breach is notified, **document every personal-data breach** in
the breach log (the facts, effects, and remedial action) so the supervisory authority
can verify compliance (Art. 33(5)). **A no-notify decision is still logged, with its
rationale.** The log is the record that proves the assessment happened.

**Location:** `[PLACEHOLDER: internal breach register location]`. Entries are internal
and may contain sensitive detail; do not store them in this public repository.

Every entry records, at minimum, these five fields:

1. **Awareness timestamp**: the date and time Piyaz became aware of the breach (the
   start of the Art. 33 72-hour clock).
2. **Facts of the breach**: what happened: the cause, the affected security property
   (confidentiality / integrity / availability), the categories and approximate number of
   data subjects and records concerned.
3. **Effects**: the likely and actual consequences of the breach for the affected data
   subjects.
4. **Remedial action taken**: the containment and mitigation measures, and any steps to
   prevent recurrence.
5. **Notification decision plus rationale**: the notify / no-notify outcome for the
   authority (Art. 33) and for data subjects (Art. 34), the reasoning behind it
   (**including the justification for any no-notify decision** and any Art. 34(3)
   exemption relied on), and, where notification was later than 72 hours, the documented
   **reason for the delay**.

---

## Quick reference

1. **Suspect a breach?** Declare an incident in `[PLACEHOLDER: incident channel]`.
   Record the awareness timestamp now.
2. **Confirm** it is a personal-data breach (confidentiality / integrity / availability).
3. **Assess** likelihood and severity of risk to data subjects (§2.2).
4. **Decide** (§2.3): unlikely → log only; likely → notify authority; high → notify
   authority **and** users.
5. **Notify the authority** within **72 hours** of awareness (§3); if late, notify anyway
   and record the delay reason.
6. **Notify users** without undue delay if high risk (§4), unless an Art. 34(3) exemption
   applies.
7. If Piyaz is a **processor**, notify the **controller** without undue delay (§5) instead
   of the authority.
8. **Log** the breach and the decision; always, including no-notify (§6).
