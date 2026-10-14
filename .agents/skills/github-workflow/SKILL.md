---
name: github-workflow
description: Review local changes and help publish a coherent commit to GitHub. Use when the user wants to review changes before committing, prepare a commit, or commit and push their work.
---

# GitHub Workflow

Use this workflow to turn the user's local project changes into a clear, reviewed commit and publish it through the repository's existing GitHub setup.

## Procedure

1. Read and respect the applicable `AGENTS.md` instructions before acting. Inspect the current branch, upstream, and Git status, including all untracked files:
   ```bash
   git status --short --branch
   git branch -vv
   git ls-files --others --exclude-standard
   ```
2. Read the unstaged, staged, and relevant untracked changes. Explain what they do, separate unrelated work, and identify which changes belong together. If the intended scope or grouping is unclear, discuss it with the user before staging anything. Leave unrelated work alone.
3. Check whether the proposed files include credentials or other secrets, local configuration, dependency manifests or lockfiles, dependency folders such as `node_modules`, build output, caches, or generated files. Never print secret values. Exclude local-only or generated files unless the user explicitly agrees they belong in the commit.
4. Identify and run relevant existing project checks when appropriate. Prefer the repository's documented checks and avoid introducing new tooling. Report what passed, failed, was unavailable, or remains untested.
5. Propose a concise commit message that accurately describes the agreed change. Ask for confirmation when the scope or message needs a decision.
6. After the user agrees on the files, stage only those files. Review the staged summary and complete staged diff:
   ```bash
   git diff --cached --stat
   git diff --cached
   ```
7. Commit and push only when the user explicitly requests it. If the user already asked to both commit and push, do not ask again unless a new problem or ambiguity appears. Use the existing branch and remote configuration. Never use force pushes or destructive Git commands, and do not introduce pull requests, CI, or new credentials.
8. Verify the result after committing and pushing:
   ```bash
   git show --stat --oneline HEAD
   git status --short --branch
   ```
   Confirm whether the push succeeded, then briefly explain what was committed and what checks were performed or remain untested.

Keep temporary details such as today's changed files out of this skill. Do not alter project files unrelated to this workflow.
