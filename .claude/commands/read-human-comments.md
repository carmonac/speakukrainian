---
description: Read the human's review comments on a PR, address them through the coder → QA → reviewer loop, and reply on GitHub
argument-hint: '[PR number] (optional — defaults to the PR for the current branch)'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite
---

Pick up human feedback on a pull request and act on it.

PR argument (may be empty): `$1`

## 1. Find the PR

If `$1` is given use it. Otherwise resolve the PR for the current branch:

```bash
gh pr view --json number,title,url,headRefName,state,reviewDecision
```

If there is no PR for this branch, say so and stop.

## 2. Collect every kind of comment

GitHub keeps these in three separate places, and it is easy to act on one and miss the others:

```bash
# Review summaries (APPROVED / CHANGES_REQUESTED / COMMENTED)
gh pr view <PR> --json reviews --jq '.reviews[] | {author: .author.login, state: .state, body: .body}'

# Inline comments anchored to lines of the diff
gh api repos/{owner}/{repo}/pulls/<PR>/comments \
  --jq '.[] | {id, author: .user.login, path, line, body, in_reply_to_id}'

# Top-level conversation comments on the PR
gh api repos/{owner}/{repo}/issues/<PR>/comments \
  --jq '.[] | {id, author: .user.login, body}'
```

Filter out comments authored by bots and by previous agent runs — you are looking for what the **human** said.

## 3. Triage

List every human comment and classify each one:

| #   | Where         | What they asked | Type                       |
| --- | ------------- | --------------- | -------------------------- |
| 1   | `src/x.ts:42` | …               | change / question / praise |

Types:

- **change** — needs a code change.
- **question** — needs an answer, and possibly a change once answered.
- **praise / acknowledgement** — no action.

If a comment is ambiguous enough that two readings lead to different code, **ask the human** rather than guessing. Guessing wrong here costs a whole review cycle.

Show the user this triage before you change anything.

## 4. Address the changes

If there are any **change** comments:

1. Launch the `coder` agent with the exact comment text, file, and line for each one. Tell it these are human review comments and carry more weight than an agent finding — the human has context the loop does not.
2. Launch the `qa` agent to verify the changes and confirm nothing regressed.
3. If QA fails, back to the Coder. Cap at 3 passes, then stop and report.

For **question** comments, answer from the code. If you cannot answer confidently, say so rather than inventing a rationale.

## 5. Reply on GitHub

Reply to each inline comment in its own thread, so the conversation stays anchored to the code:

```bash
gh api repos/{owner}/{repo}/pulls/<PR>/comments \
  -f body="<reply>" -F in_reply_to=<comment_id>
```

Each reply says what you did — or, if you disagree, why, plainly and without arguing. For general comments, post one summary comment:

```bash
gh pr comment <PR> --body "$(cat <<'EOF'
## Review feedback addressed

| Comment | Action |
|---------|--------|
| <summary> | <what changed, with commit sha> |

<Anything you disagreed with, and why.>
<Anything you need the human to decide.>

Gate after changes: lint ✅ typecheck ✅ test ✅ build ✅
EOF
)"
```

## 6. Push

```bash
git push
```

Never force-push. The human's comments are anchored to existing commits, and rewriting history detaches them.

## 7. Report

Tell the user: how many comments there were, how many needed changes, what you changed, anything you pushed back on, and anything still waiting on them.

## Rules

- **Never dismiss a human comment.** Address it or explain why not — silence is not an option.
- **Do not merge.** That is the human's call.
- If the human's request conflicts with something in `CLAUDE.md` or `docs/architecture.md`, say so in your reply, then do what they asked. They may be deciding to change the convention.
- Be honest about what you did not do and why.
