# Part 3 — Thinking Answers

> Scenario (3:00 AM WhatsApp from a Villa B1 guest): *"There is no hot water and we have guests arriving for breakfast in 4 hours. This is unacceptable. I want a refund for tonight."*

---

## Question A — The Immediate Response

> Hi [Guest Name], I am truly sorry — no hot water at 3am with breakfast guests arriving in 4 hours is not acceptable, and I understand the urgency. I am waking our on-call team and caretaker right now; someone will contact you within 30 minutes with a fix or an alternative. I have also flagged your refund request — our team will address that with you once we have the immediate issue sorted. We will make this right tonight.

**Why this wording:** It names the refund explicitly so the guest knows the ask was heard, commits to 30 minutes against their 4-hour deadline, and promises neither the fix nor the refund — both are human decisions, not the AI's.

---

## Question B — The System Response

The platform must act in parallel the moment the message lands:

1. Classify as `complaint` → force action `escalate`, skip auto-send.
2. Open a critical incident tagged `villa-b1`, `hot_water`, `3am`, `breakfast_in_4h`, `refund_requested`.
3. Page (SMS + push) the on-call property manager and the Villa B1 caretaker immediately.
4. Log the message, channel, confidence score, and `reservation_id` so refund review has the full thread.
5. Start a 30-minute SLA timer.
6. **At 30 minutes with no human ack:** escalate to the operations lead and property owner; auto-reply to the guest: *"We are still actively working on this and have escalated to our senior team."*
7. At 60 minutes: escalate to the founder.

The AI reply is a holding message. The system's real job is getting a human moving within 30 minutes.

---

## Question C — The Learning

Three complaints in two months means the pattern threshold is already breached — today's reply is too late. The system should fire now:

1. Auto-open a P1 preventive maintenance task for Villa B1 hot water; block new check-ins until the caretaker verifies.
2. Tag Villa B1 in the property health dashboard: `repeat: hot_water (3x / 60d)`.
3. Override auto-send for any hot-water complaint at this villa indefinitely — always human review.
4. Add hot water to the caretaker's pre-arrival checklist for Villa B1.

**To prevent a fourth time:** install a remote-monitored hot water sensor that pings ops when temperature drops, plus a weekly automated probe. Move detection upstream of the guest. The right complaint is one that never reaches the inbox.
