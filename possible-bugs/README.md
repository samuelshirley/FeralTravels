# possible-bugs

This folder is a working journal of suspected bugs, edge cases, and architectural risks that **haven't manifested yet** but are worth watching. It's not a bug tracker (use whatever issue system you actually use for that). It's a place to write down the thing you're worried about while it's still fresh, so a year from now when a weird symptom shows up someone can grep here and find the matching theory.

Each file describes one issue. Suggested structure (loose — adapt as needed):

- **Status:** `suspected` / `confirmed` / `mitigated` / `fixed` / `obsolete`
- **Where it lives:** file paths and a one-line orientation
- **The mechanism:** what could go wrong, in two or three sentences
- **Why it matters:** user-facing impact if it happens
- **Symptoms — user-facing:** what the user would notice
- **Symptoms — developer-facing:** what would show up in logs, queries, or admin views
- **How to detect:** specific queries, log filters, or manual checks
- **How to fix:** sketch of the patch, plus what we'd need to know first
- **History:** when noted, when last reviewed, what changed it

Promote a file out of this folder once it's either fixed (delete it) or confirmed enough to belong in your real issue tracker (move it). Don't let this become a graveyard.
