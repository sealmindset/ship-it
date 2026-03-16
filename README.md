# /ship-it

A Claude Code skill and GitHub Action that gets a developer's code into production with zero DevOps knowledge required. Run `/ship-it` and it handles everything -- branching, committing, pushing, workflow generation, PR creation, reviewer assignment, and a go-live checklist.

## What It Does

| Command | What Happens |
|---------|-------------|
| `/ship-it` | Ships your code to production. Creates a branch, pushes, generates a CI/CD workflow, creates a PR with reviewers and a go-live checklist. |
| `/ship-it save` | Saves your work in progress. Commits, pushes, creates a draft PR. No review triggered. |

The developer sees two sentences of output. Everything else happens silently.

### How It Works

1. **Silent preflight** -- Checks git repo, GitHub auth, current branch, `.ship-it.yml` config, `app-context.json` (from /make-it), open PRs, uncommitted changes, and project type. All in one command.
2. **Intent classification** -- Three yes/no questions determine if this is an experiment, shareable, or production-ready.
3. **Branch + commit + push** -- Creates a branch if on main, stages changes, commits, pushes.
4. **Workflow generation** -- If no CI/CD workflow exists, generates one based on available infrastructure config.
5. **PR creation** -- Creates a labeled PR with app details, reviewer assignment, and a smart go-live checklist.
6. **Done** -- Reports back with the PR URL.

### Three Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Ship** | `/ship-it` (default) | Full production path -- branch, push, workflow, PR with reviewers |
| **Save** | `/ship-it save` | Work-in-progress -- push and create draft PR |
| **Re-run** | `/ship-it` when PR already exists | Updates existing PR with new commits, or reports PR status |

### Intent Classification

Three yes/no questions classify every deployment:

| Intent | Label | Deploy Target | Meaning |
|--------|-------|---------------|---------|
| Experiment | `intent:experiment` | None | "Just trying something out" |
| Shareable | `intent:shareable` | Dev only | "Others should see this" |
| Prod-ready | `intent:prod-ready` | Dev + Prod | "This is ready for real users" |

## Works With /make-it

When used on a project built by [/make-it](https://github.com/sealmindset/make-it), `/ship-it` automatically reads `app-context.json` and `.make-it-state.md` to:

- Skip app-type and stack questions (already known)
- Auto-generate the `app` section of `.ship-it.yml`
- Create a smart prerequisites checklist (pre-checking items make-it already configured)
- Populate the PR body with app details (stack, services, auth, database)

`/ship-it` also works standalone on any GitHub project -- it just asks a few extra questions.

See [docs/handoff.md](docs/handoff.md) for the full merge logic.

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

Or reference a shared reusable workflow:

```yaml
name: ship-it pipeline
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ship-it:
    uses: {ORG}/{REPO}/.github/workflows/ship-it-pipeline.yml@main
    with:
      environment-dev: dev
      environment-prod: prd
    secrets: inherit
```

## Configuration

### `.ship-it.yml`

Drop this file in the root of any repo. It has three sections with different owners:

```yaml
# APP -- What is being deployed (auto-populated by /make-it, or filled by developer)
app:
  name: "TaskHub"
  slug: "task-hub"
  description: "Team task management app"
  stack: "fastapi-nextjs"
  project_type: "web-app"
  services:
    - name: backend
      dockerfile: backend/Dockerfile
      port: 8000
      health_check: /health
      cpu: 512
      memory: 1024
    - name: frontend
      dockerfile: frontend/Dockerfile
      port: 3000
      health_check: /
      cpu: 256
      memory: 512
  database:
    engine: postgresql
    version: "16"
  auth:
    provider: oidc

# INFRA -- Where and how to deploy (filled by DevOps)
infra:
  provider: aws
  aws:
    region: us-east-1
    account_id: "123456789012"
    ecr_registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com"
    vpc_id: "vpc-abc123"
    private_subnets: ["subnet-abc123", "subnet-def456"]
    public_subnets: ["subnet-ghi789", "subnet-jkl012"]
    ecs:
      cluster_name: "apps-cluster"
      execution_role_arn: "arn:aws:iam::123456789012:role/ecsTaskExecutionRole"
      task_role_arn: "arn:aws:iam::123456789012:role/ecsTaskRole"
    rds:
      instance_class: db.t3.micro
      allocated_storage: 20
      multi_az: false
    alb:
      certificate_arn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123"
      health_check_path: /health
    dns:
      hosted_zone_id: "Z1234567890"
      domain: "apps.example.com"
    secrets:
      prefix: /make-it

# DEPLOYMENT -- How the pipeline behaves
deployment:
  environments:
    dev: dev
    staging: staging
    production: production
  reviewers:
    - devops-lead
    - team-lead
  prerequisites:
    - "Does this app need users to log in? (SSO / App registration)"
    - "Does this need a secure web address? (SSL certificate)"
    - "Who should have access in production? (Permissions / RBAC)"
    - "Does this need a URL people can visit? (DNS setup)"
    - "Does this need to talk to internal systems? (Network / firewall)"
  strategy: rolling
  rollback: true
```

**Merge priority** (highest wins):
1. `.ship-it.yml` values (DevOps overrides everything)
2. `app-context.json` values (from /make-it)
3. Auto-detected values (stack detection, git context)
4. Sensible defaults

If `.ship-it.yml` is missing, `/ship-it` uses sensible defaults for everything.
If only `app` is present (no `infra`), `/ship-it` creates the PR but marks deployment as "pending DevOps configuration."

See [templates/ship-it.yml](templates/ship-it.yml) for the full template with comments.

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
> **Done!** Your code is on its way.
> https://github.com/your-org/your-repo/pull/42
>
> The team will review it and let you know when it's live.

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
  config-loader.js            # Loads and merges .ship-it.yml + app-context.json + auto-detect
  intent.js                   # Intent classification (experiment/shareable/prod-ready)
  blocker-scan.js             # Scans for merge conflicts, failing checks, issues
  pr-builder.js               # Creates/updates PRs with app details, infra status, checklists
  prompt-flow.js              # Interactive CLI flow (skips questions when make-it context exists)
  workflow-gen.js              # Generates AWS/Azure/placeholder workflows from config
  auth-handler.js              # Translates auth errors to plain language
  __tests__/
    auth-handler.test.js
    config-loader.test.js     # Config merge logic tests
    intent.test.js
templates/
  ship-it.yml                 # Generic .ship-it.yml template (3 sections)
  ship-it-aws.yml             # AWS-specific template with field-by-field instructions
  ship-it-azure.yml           # Azure-specific template with field-by-field instructions
  checklist-prod.md           # Production go-live checklist template
  pr-description.md           # PR description template
  workflow.yml                # GitHub Actions workflow template (fallback)
docs/
  devops-guide.md             # DevOps onboarding guide (how to fill in .ship-it.yml)
  handoff.md                  # make-it to ship-it merge logic
  devops_skill.md             # Detailed skill specification
action.yml                    # GitHub Action definition
package.json                  # Node.js dependencies
```

## Safety Guardrails

- Auth failure -- stops and tells you how to fix it
- Merge conflicts -- stops, explains in plain language, offers to help. Never force-pushes.
- Existing workflow files -- never overwrites
- Missing `.ship-it.yml` -- uses defaults, never blocks
- Missing `infra` section -- creates PR but marks deployment as pending. Never blocks.
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

## Related Projects

| Project | Purpose | Repo |
|---------|---------|------|
| `/make-it` | Build a new app from idea to working code | [sealmindset/make-it](https://github.com/sealmindset/make-it) |
| `/ship-it` | Deploy code to production (this repo) | [sealmindset/ship-it](https://github.com/sealmindset/ship-it) |
| `harness-it` | Test harness for validating make-it + ship-it integration | [sealmindset/harness-it](https://github.com/sealmindset/harness-it) |

## License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) -- free to use, share, and adapt with attribution.
