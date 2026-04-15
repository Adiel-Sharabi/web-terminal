# Plan Feature

Add a feature idea to the PLANS.md backlog with details.

## Usage

```
/plan-feature <feature description>
```

## Steps

1. **Read** `PLANS.md` in the project root to see existing features and sections
2. **Determine the right section** for the feature (UI/Sidebar, Session Intelligence, Mobile, Cluster, Developer Experience — or create a new section if none fit)
3. **Check for duplicates** — if a similar feature already exists, update it instead of adding a new one
4. **Add the feature** with:
   - A clear one-line title
   - 2-3 sentences describing what it does and why it's useful
   - Any technical notes on implementation approach (brief)
5. **Save** the updated PLANS.md

## Format

Each feature entry in PLANS.md should look like:

```markdown
- **Feature Title** — Brief description of what it does.
  _Why:_ The user benefit or problem it solves.
  _Approach:_ Brief technical approach if known.
```

## Rules

- Keep entries concise — this is a backlog, not a spec
- Don't remove or reorder existing entries
- Don't commit — just edit the file. The user will commit when ready.
