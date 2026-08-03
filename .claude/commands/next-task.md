---
description: Pick up the next GitHub issue and run it through architect → coder → QA → reviewer until it converges, then open a PR
argument-hint: '[issue number] (optional — defaults to the next unblocked issue)'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite
---

Run the next unit of work through the full agent loop, ending with a pull request for human review.

Issue argument (may be empty): `$1`

## 1. Select the issue

If `$1` is given, use issue `$1`.

Otherwise pick the next one to work on:

```bash
gh issue list --state open --label phase-1 --json number,title,labels,body --limit 50
```

Choose the **lowest-numbered open issue whose blockers are all closed**. Blockers are written as `Blocked by #N` in the issue body. Skip anything already labelled `in-progress`. If every open issue is blocked, say so and stop.

Announce which issue you picked and why.

## 2. Set up state

```bash
mkdir -p .agent/plans .agent/state
gh issue edit <N> --add-label in-progress
```

Create `.agent/state/issue-<N>.md` with a `# Issue <N> — <title>` heading if it does not exist.

## 3. Architect — plan

Launch the `architect` agent in task-planning mode for issue `<N>`. It writes `.agent/plans/issue-<N>.md`.

Read the plan yourself before continuing. If it is missing or obviously incomplete, send it back once with specifics.

## 4. The loop

Run this until it converges. **Hard cap: 5 Coder passes.** If you hit the cap, stop and hand the whole state file to the human — do not open a PR for work that would not converge.

```
Coder → QA → (FAIL? back to Coder) → Reviewer → (CHANGES REQUESTED? back to Coder → QA) → done
```

**Coder pass.** Launch the `coder` agent with the issue number, the plan path, and — on a rework pass — the full list of QA defects and/or Reviewer blocking comments. Be explicit that every finding must be addressed.

**QA pass.** Launch the `qa` agent. It runs the gate itself and returns PASS or FAIL.

- FAIL → go back to the Coder with the defects. Do not proceed to review.
- PASS → continue.

**Reviewer pass.** Launch the `reviewer` agent.

- CHANGES REQUESTED → back to the Coder with the blocking comments. Because the code changes again, **QA must run again afterwards** before the next review.
- APPROVE → the loop is done.

Never run QA and the Reviewer concurrently — the Reviewer's job depends on QA having passed.

After each pass, append the agent's verdict to `.agent/state/issue-<N>.md` and tell the user where things stand in one line.

## 5. Open the pull request

Commit anything outstanding, push the branch, and open the PR:

```bash
git push -u origin HEAD
gh pr create --base main \
  --title "<type>(<area>): <what changed> (#<N>)" \
  --body "$(cat <<'EOF'
## Summary
<2–4 sentences: what changed and why>

Closes #<N>

## What the agents found
- **QA**: <passes taken, defects found and fixed>
- **Review**: <passes taken, blocking comments resolved>

## Verification
- `pnpm lint` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅ (<N> tests)
- `pnpm build` ✅
- e2e: <result or "not applicable">

## For the human reviewer
<Anything genuinely worth a second opinion — a judgement call made, an assumption taken,
a trade-off. If there is nothing, say so rather than padding.>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then:

```bash
gh issue edit <N> --remove-label in-progress --add-label in-review
```

## 6. Report

Give the user: the PR URL, how many Coder passes it took, what QA and Review caught, and anything the human should look at closely.

Stop there. The human reviews the PR. `/read-human-comments <PR>` picks it up from their feedback.

## Rules

- **Do not implement anything yourself.** You orchestrate; the subagents do the work.
- **Do not skip QA or the Reviewer**, even for a one-line change.
- **Do not open a PR while QA is failing or the Reviewer is blocking.** A red PR wastes the human's time, which is the scarcest thing in this loop.
- **Do not merge.** The human merges.
- Report honestly. If the loop hit the pass cap, or something is only partly done, say exactly that.
