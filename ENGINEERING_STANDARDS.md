# Engineering Standards — Working Agreement for AI-Assisted Development

> **Purpose.** This document is *law*, not suggestion. It exists to stop the failure mode where AI generates code fast, it works in a demo, then collapses under real users — duplicated logic, direct DB calls from the UI, and every bug fix spawning two new ones. The rules below force **Single Source of Truth**, **Root-Cause-First**, and **minimal-blast-radius** change discipline so that each new feature makes the codebase *faster* to extend, not slower.
>
> **How to apply.** Drop this file into a project root and reference it from `CLAUDE.md` with a line like `@ENGINEERING_STANDARDS.md`, or paste the "Prime Directives" section directly into `CLAUDE.md`. These instructions override default behavior. When a rule here conflicts with speed, the rule wins — flag the tradeoff, don't silently skip it.

---

## 0. Prime Directives (non-negotiable)

1. **Understand before you change.** No edit ships until the full picture is proven — the layer, the call path, the root cause. Reading code beats guessing.
2. **One source of truth per fact.** Every value, rule, type, and calculation lives in exactly one authoritative place. Everything else imports it. No copies.
3. **Fix causes, not symptoms.** A patch that hides a symptom without addressing the cause is a defect, not a fix.
4. **Smallest change that fully solves it.** Minimize blast radius. Broad rewrites need explicit justification and sign-off.
5. **Respect the boundaries.** UI does not touch the database. Business logic does not know about HTTP. Layers talk through defined interfaces only.
6. **Prove it works.** "Done" means observed working end-to-end, not "the code compiles" or "looks right."
7. **Leave it enforceable.** When you establish a rule, add the test/lint/CI gate that keeps a future edit (human or AI) from breaking it.

---

## 1. Single Source of Truth (SSOT)

**The rule:** Any given piece of knowledge — a business rule, a constant, a type/schema, a formula, a config value — has **one** canonical definition. All consumers reference it. If you find yourself copy-pasting logic or "keeping two things in sync," stop: that is a bug being born.

**Do:**
- Centralize domain logic in a service/module/layer. Callers invoke it; they do not reimplement it.
- Derive, don't duplicate. If value B can be computed from A, compute it — don't store both and hope they agree.
- One schema definition, generated/shared across layers (DB ↔ API ↔ client) rather than retyped in each.
- Constants and enums defined once and imported.

**Never:**
- Direct database queries or ORM calls from UI/view/component code. Data access goes through a repository/service layer.
- The same validation, rounding, tax rule, permission check, or date-math implemented in two places.
- "I'll just inline this here too, it's only a couple lines." Two copies = two things that will drift.

**When you spot a duplicate:** surface it. Propose consolidating to one owner *before* adding the third copy.

**Enforce it (add these gates):**
- A lint rule / architecture test that fails the build if UI-layer files import the DB/ORM client directly.
- Dependency-direction tests (e.g., ArchUnit, `dependency-cruiser`, `import-linter`, or a simple grep gate) asserting `ui → service → data`, never the reverse or the shortcut.

---

## 2. Root-Cause-First Investigation

The single largest source of wasted time is patching symptoms. Follow this protocol on **every** bug:

1. **Reproduce** the failure and capture exact errors/logs verbatim — don't paraphrase.
2. **Locate the layer** — client vs. server, which module — *before* touching code. State it.
3. **Trace the real path.** Read the actual functions/classes in the chain. Prove which line misbehaves; don't assume.
4. **State the root cause** in one sentence: "X happens because Y." If you can't, you haven't found it yet.
5. **Present hypothesis + proposed fix for review** before editing files on anything non-trivial.
6. **Fix the cause once**, at its SSOT owner — so every caller benefits, not just the reported screen.
7. **Add a regression test** that fails before the fix and passes after.

**Red flags that you're symptom-patching** (stop and re-investigate):
- Adding a special-case `if` to suppress one bad output.
- A `try/catch` that swallows the error instead of preventing it.
- Fixing the same class of bug in a second, third location — that means the cause lives upstream.
- "It works now" without being able to explain *why* it was broken.

**Third-party / external-team reports:** don't assume the bug is in our code. First check whether the API is being used correctly. Only call it "our bug" once proven with evidence.

---

## 3. Regression Prevention (the ripple-effect killer)

Interconnected code means one fix ripples into new breakage. Contain it:

- **Characterize before you change.** For any non-trivial edit, know (or add) a test that pins current correct behavior first.
- **Change behind stable interfaces.** Modify the implementation, keep the contract — callers shouldn't feel it.
- **Map the blast radius.** Before editing a shared function, find every caller and state how each is affected. (Delegate the "find all callers" sweep to a search agent to keep it cheap.)
- **One logical change per commit.** Don't smuggle a refactor inside a bug fix. Reviewers can't reason about mixed diffs.
- **Never delete/replace something you didn't inspect.** If what you find contradicts how it was described, surface that — don't bulldoze.
- **Regression test is part of the fix**, not optional follow-up. The fix isn't done without it.

---

## 4. Change Discipline & Minimal Blast Radius

- **Match the surrounding code.** New code reads like the code around it — same naming, idioms, comment density, error handling. Consistency > personal preference.
- **Smallest diff that fully solves the problem.** Resist scope creep. If you notice unrelated issues, note them separately; don't fold them in.
- **No speculative abstraction.** Don't build for imagined future needs. Solve today's problem cleanly; abstract on the *second* real use, not the first guess.
- **No dead code, no commented-out blocks, no TODO-as-implementation.** Delete it or do it.
- **Reversibility check.** For anything hard to undo or outward-facing (deletes, migrations, external calls, force-pushes), confirm before acting. Approval for one action does not extend to the next.

---

## 5. Architecture Before Code

This is the article's core claim: AI without architectural constraints produces spaghetti; AI *with* them compounds. So:

- **Define boundaries first.** For any new subsystem, name the layers and what each may depend on before writing feature code.
- **Data flows one direction.** UI → application/service → domain → data. Dependencies point inward. Nothing skips a layer to "save time."
- **Interfaces are contracts.** Cross-boundary calls go through explicit, typed interfaces — not by reaching into another layer's internals.
- **Config and secrets are injected, not hard-coded or reached-for globally.**
- **Refactor before scaling, not after it breaks.** When a module starts accreting special cases, that's the signal to consolidate — proactively.

---

## 6. Definition of Done (Verification)

A change is **not done** until:

- [ ] Root cause understood and stated (for fixes).
- [ ] Change is at the SSOT owner; no logic duplicated to make it work.
- [ ] Layer boundaries respected; no new UI→DB or reverse-direction dependency.
- [ ] Exercised **end-to-end** in the real flow — behavior *observed*, not merely compiled. Report what was run and what was seen.
- [ ] Regression test added; it fails without the change, passes with it.
- [ ] Existing tests / typecheck / lint / build all green — and said so honestly if not.
- [ ] Diff is minimal, single-purpose, and matches surrounding style.
- [ ] Any new invariant is backed by an automated gate (§7).

Report outcomes faithfully. If tests fail, say so with the output. If a step was skipped, say that. State "done and verified" plainly only when it's true.

---

## 7. Make the Rules Enforceable (CI as the guardrail)

Documentation alone drifts. Every principle above should, where feasible, become a check that *blocks the merge*:

| Principle | Automated gate |
|---|---|
| No UI→DB access | Lint/arch test failing on DB-client imports in UI layer |
| Dependency direction | `dependency-cruiser` / `import-linter` / ArchUnit rule |
| SSOT for logic | Duplication detector (e.g., `jscpd`) with a hard threshold; PR flags copy-paste |
| No regressions | Test suite required green; new fix ships with its regression test |
| Consistent style | Formatter + linter enforced in CI, not by hand |
| Type safety | Typecheck required green |

When you add a new rule to a project, add its gate in the same change. A rule with no gate is a suggestion that will be violated within weeks.

---

## 8. Working Protocol for the AI Assistant

Before editing on any non-trivial task, respond with:

1. **Understanding** — what the code actually does now (proven by reading, with `file:line` references).
2. **Root cause / rationale** — why the change is needed, at which layer.
3. **Plan** — the minimal change, its SSOT owner, and its blast radius (affected callers).
4. **Verification plan** — how "done" will be proven.

Then act. Prefer delegating wide "where is X / who calls Y" searches to a cheap search agent to keep the main context focused. When genuinely blocked on a decision that's the user's to make, ask — don't guess on architecture-shaping choices.

---

*Standard applies across projects. Speed is a byproduct of good structure, not a substitute for it.*
