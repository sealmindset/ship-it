# /ship-it

A Claude Code skill and GitHub Action that gets a developer's code into production with zero DevOps knowledge required. Run `/ship-it` and it handles everything -- branching, committing, pushing, workflow generation, PR creation, reviewer assignment, and a go-live checklist.

## What It Does

| Command | What Happens |
|---------|-------------|
| `/ship-it` | Ships your code to production. Creates a branch, pushes, generates a CI/CD workflow, creates a PR with reviewers and a go-live checklist. |
| `/ship-it save` | Saves your work in progress. Commits, pushes, creates a draft PR. No review triggered. |

The developer sees two sentences of output. Everything else happens silently.

### How It Works

1. **Silent preflight** -- Checks git repo, GitHub auth, current branch, `.ship-it.yml` config, open PRs, uncommitted changes, and project type. All in one command.
2. **Branch + commit + push** -- Creates a branch if on main, stages changes, commits, pushes.
3. **Workflow generation** -- If no CI/CD workflow exists, generates a lightweight caller workflow referencing the org's shared reusable workflow.
4. **PR creation** -- Creates a labeled PR with a plain-language description, reviewer assignment, and a go-live checklist for infrastructure needs.
5. **Done** -- Reports back with the PR URL.

### Three Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Ship** | `/ship-it` (default) | Full production path -- branch, push, workflow, PR with reviewers |
| **Save** | `/ship-it save` | Work-in-progress -- push and create draft PR |
| **Re-run** | `/ship-it` when PR already exists | Updates existing PR with new commits, or reports PR status |

### Intent Classification

When running as a GitHub Action in CI mode, the skill classifies PRs into three intent levels:

| Intent | Label | Deploy Target | Meaning |
|--------|-------|---------------|---------|
| Experiment | `intent:experiment` | None | "Just trying something out" |
| Shareable | `intent:shareable` | Dev only | "Others should see this" |
| Prod-ready | `intent:prod-ready` | Dev + Prod | "This is ready for real users" |

## Prerequisites

| Tool | How to Install |
|------|---------------|
| Git | `brew install git` |
| GitHub CLI | `brew install gh` then `gh auth login` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |

## Installation

### As a Claude Code Skill

1. Clone this repo:

```bash
git clone https://github.com/sealmindset/ship-it.git ~/.claude/ship-it-skill
```

2. Copy the skill file into your Claude Code commands directory:

```bash
mkdir -p ~/.claude/commands
cp ~/.claude/ship-it-skill/skills/ship-it/SKILL.md ~/.claude/commands/ship-it.md
```

3. Verify it's available:

```bash
claude
# Then type /ship-it
```

### As a GitHub Action

Add the action to your workflow:

```yaml
name: ship-it pipeline
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ship-it:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sealmindset/ship-it@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Or reference the shared reusable workflow:

```yaml
name: ship-it pipeline
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ship-it:
    uses: SleepNumberInc/sleep-number-claude-code-plugins/.github/workflows/ship-it-pipeline.yml@main
    with:
      environment-dev: dev
      environment-prod: prd
    secrets: inherit
```

## Configuration

### `.ship-it.yml` (optional)

Drop this file in the root of any repo. DevOps owns it. If missing, `/ship-it` uses sensible defaults.

```yaml
# Reviewers auto-assigned to every production PR
reviewers:
  - team-lead-username

# GitHub environment names (configure protection rules in repo settings)
environments:
  dev: dev
  production: production

# Path to existing CI/CD workflow (if set, /ship-it won't generate one)
# workflow: .github/workflows/deploy.yml

# Go-live checklist items added to every production PR
prerequisites:
  - "Does this app need users to log in? (SSO / App registration)"
  - "Does this need a secure web address? (SSL certificate)"
  - "Who should have access in production? (Permissions / RBAC)"
  - "Does this need a URL people can visit? (DNS setup)"
  - "Does this need to talk to internal systems? (Network / firewall)"

# Default PR title if developer doesn't provide one
# description: "My application"
```

### Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | `${{ github.token }}` | GitHub token for API access |
| `mode` | No | `ci` | `interactive` for CLI Q&A, `ci` for automated pipeline |
| `intent` | No | (from labels) | Override intent: `experiment`, `shareable`, `prod-ready` |
| `dev-environment` | No | `dev` | GitHub environment name for dev |
| `prod-environment` | No | `production` | GitHub environment name for production |
| `working-directory` | No | `.` | Directory to run in |

### Action Outputs

| Output | Description |
|--------|-------------|
| `intent` | Classified intent: `experiment`, `shareable`, `prod-ready` |
| `pr-url` | URL of created/updated PR |
| `pr-number` | PR number |
| `blockers-found` | Whether hard blockers were detected (`true`/`false`) |
| `blocker-summary` | Plain-language summary of blockers |
| `deploy-target` | Where to deploy: `none`, `dev`, `dev+prod` |

## Usage

### Ship to Production

```bash
cd ~/my-project
claude
/ship-it
```

Output:
> **Done!** Your code is on its way to production.
> https://github.com/your-org/your-repo/pull/42
>
> The team will review it and let you know if they have any questions. Otherwise, they'll let you know when it's live.

### Save Work in Progress

```bash
/ship-it save
```

Output:
> **Saved!** Your work is backed up.
> Run `/ship-it` when you're ready to go live.

### Re-run (PR Already Open)

```bash
/ship-it
```

If you have new changes, they get pushed. If not, you get a status update on the existing PR.

## Architecture

```
skills/
  ship-it/
    SKILL.md                  # Claude Code skill definition (the /ship-it command)
src/
  index.js                    # Entry point -- routes to interactive or CI mode
  intent.js                   # Intent classification (experiment/shareable/prod-ready)
  blocker-scan.js             # Scans for merge conflicts, failing checks, issues
  pr-builder.js               # Creates/updates PRs with labels and checklists
  prompt-flow.js              # Interactive CLI flow orchestration
  workflow-gen.js              # GitHub Actions workflow generation
  auth-handler.js              # Translates auth errors to plain language
  __tests__/
    auth-handler.test.js
    intent.test.js
templates/
  ship-it.yml                 # Example .ship-it.yml configuration
  checklist-prod.md           # Production go-live checklist template
  pr-description.md           # PR description template
  workflow.yml                # GitHub Actions workflow template
docs/
  RFC_2024-001_*.md           # RFC specification
  devops_skill.md             # Detailed skill documentation
action.yml                    # GitHub Action definition
package.json                  # Node.js dependencies
```

## Safety Guardrails

- Auth failure -- stops and tells you how to fix it
- Merge conflicts -- stops, explains in plain language, offers to help. Never force-pushes.
- Existing workflow files -- never overwrites
- Missing `.ship-it.yml` -- uses defaults, never blocks
- Already merged / nothing to ship -- tells you and stops
- Never leaves the repo in a broken state
- Never shows raw git/gh output
- Every error gives a plain-language explanation and next step

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build the action
npm run build

# Lint
npm run lint
```

## Related Skills

| Skill | Purpose | Repo |
|-------|---------|------|
| `/make-it` | Build a new app from idea to working code | [sealmindset/make-it](https://github.com/sealmindset/make-it) |
| `/resume-it` | Continue working on an existing app (inside make-it) | [sealmindset/make-it](https://github.com/sealmindset/make-it) |

## License

MIT
