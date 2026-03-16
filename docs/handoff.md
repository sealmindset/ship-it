# make-it to ship-it Handoff

How `/ship-it` consumes context from `/make-it` and merges it with DevOps infrastructure configuration.

## Context Flow

```
/make-it                    /ship-it                     DevOps
   |                           |                           |
   |  app-context.json         |                           |
   |  .make-it-state.md        |                           |
   |-------------------------->|                           |
   |                           |     .ship-it.yml          |
   |                           |     (infra + deployment)  |
   |                           |<--------------------------|
   |                           |                           |
   |                           |  MERGE                    |
   |                           |  .ship-it.yml > app-context > auto-detect > defaults
   |                           |                           |
   |                           |  PR + workflow + checklist |
   |                           |-------------------------->|
```

## Files Involved

### From /make-it (developer's project)

| File | Purpose | Created by |
|------|---------|------------|
| `.make-it/app-context.json` | App identity, stack, services, features, roles | /make-it Phase 2 (Design) |
| `.make-it-state.md` | Build status, what was verified, next steps | /make-it Phase 3 (Build) |

### From DevOps (organization or per-repo)

| File | Purpose | Created by |
|------|---------|------------|
| `.ship-it.yml` | Three-section config: app + infra + deployment | DevOps team (or auto-generated) |

## Merge Priority

When the same value could come from multiple sources, the highest-priority source wins:

```
1. .ship-it.yml values         (DevOps overrides everything)
2. app-context.json values     (/make-it's design decisions)
3. Auto-detected values        (stack detection, git context)
4. Sensible defaults           (hardcoded fallbacks)
```

### Merge Examples

**App name:**
- `.ship-it.yml` has `app.name: "TaskHub"` -> use "TaskHub"
- `.ship-it.yml` has no name, `app-context.json` has `project_name: "TaskHub"` -> use "TaskHub"
- Neither exists -> summarize from git log

**Stack:**
- `.ship-it.yml` has `app.stack: "fastapi-nextjs"` -> use it
- `.ship-it.yml` has no stack, `app-context.json` has `stack: "fastapi-nextjs"` -> use it
- Neither exists -> detect from `package.json`, `requirements.txt`, etc.

**Services:**
- `.ship-it.yml` has `app.services` populated -> use them (DevOps may have adjusted CPU/memory)
- `.ship-it.yml` has no services, `app-context.json` has `services` -> convert to `.ship-it.yml` format
- Neither exists -> detect from `Dockerfile` / `docker-compose.yml`

**Infrastructure:**
- `.ship-it.yml` has `infra.aws.account_id` populated -> fully configured, generate real deploy steps
- `.ship-it.yml` has `infra` section but values are empty -> mark as "pending DevOps configuration"
- No `infra` section at all -> same as empty, mark as pending

**Reviewers:**
- `.ship-it.yml` has `deployment.reviewers` -> assign them to PR
- No reviewers -> check `CODEOWNERS`. If neither, skip reviewer assignment.

## .ship-it.yml Auto-Generation

When `/ship-it` runs on a project that has `app-context.json` but no `.ship-it.yml`:

1. Create `.ship-it.yml` with the `app` section populated from `app-context.json`
2. Leave `infra` section with empty placeholder values
3. Set `deployment` section with sensible defaults
4. Commit: `git add .ship-it.yml && git commit -m "Add ship-it config"`

### Field Mapping: app-context.json -> .ship-it.yml

| app-context.json | .ship-it.yml |
|-----------------|--------------|
| `project_name` | `app.name` |
| `project_slug` | `app.slug` |
| `features` (summarized) | `app.description` |
| `stack` | `app.stack` |
| `project_type` | `app.project_type` |
| `services[].name` | `app.services[].name` |
| `services[].port` | `app.services[].port` |
| `services[].health_check` | `app.services[].health_check` |
| `database.engine` | `app.database.engine` |
| `database.version` | `app.database.version` |
| `auth.provider` | `app.auth.provider` |

Fields NOT mapped (DevOps fills these):
- `infra.*` (cloud provider, networking, clusters, DNS, secrets)
- `deployment.reviewers`
- `deployment.reusable_workflow`
- `app.services[].cpu` / `app.services[].memory` (defaults provided, DevOps overrides)

## Intent Classification

Always happens, even when make-it context exists. The 3 intent questions are about the **deployment**, not the app:

1. "Will anyone else use this besides you?"
2. "Does it touch real data?"
3. "If this broke, would anyone besides you notice?"

**Shortcut:** If `.make-it-state.md` shows the app passed build-verify and the user explicitly said "this is ready for production," skip to `prod-ready` without asking.

| Answers | Intent | Pipeline behavior |
|---------|--------|-------------------|
| Q2=yes OR Q3=yes | `prod-ready` | Full safety: lint required, security required, approval required, dev+prod deploy |
| Q1=yes (Q2/Q3=no) | `shareable` | Clean setup: lint best-effort, security best-effort, dev deploy only |
| All no | `experiment` | Minimal: CI only, no deploy |

## Workflow Generation

The generated workflow adapts based on what's available:

### With `deployment.reusable_workflow`
Generate a thin caller workflow that references the org's shared pipeline:
```yaml
jobs:
  ship-it:
    uses: {org}/{repo}/.github/workflows/ship-it-pipeline.yml@main
    with:
      environment-dev: dev
      environment-prod: production
    secrets: inherit
```

### With `infra` section populated
Generate a full deployment workflow with real steps:
- Build Docker images (from `app.services[].dockerfile`)
- Push to ECR/ACR (from `infra.aws.ecr_registry` or `infra.azure.acr_name`)
- Store/rotate secrets (from `infra.aws.secrets.prefix`)
- Run database migrations
- Deploy to ECS/AKS (from `infra.aws.ecs` or `infra.azure.aks_cluster`)
- Health check (from `app.services[].health_check`)

### Without `infra` (pending DevOps)
Generate a workflow with placeholder deploy steps:
```yaml
- name: Deploy
  run: |
    echo "Deployment pending -- DevOps infrastructure not yet configured"
    echo "Fill in the infra section of .ship-it.yml to enable deployment"
```

## PR Body Structure

The PR body adapts based on available context:

```markdown
## What this does
{From app-context.json description, or summarize commits}

## App details                    <-- Only if app-context.json exists
- **Stack:** {stack}
- **Services:** {list with ports}
- **Auth:** {provider}
- **Database:** {engine}

## Who's affected
{Based on intent classification}

## Data involved
{Based on intent Q2: "Real data" or "Test/synthetic data only"}

## Risk if something goes wrong
{Based on intent Q3: "Low" / "Medium" / "High"}

## Infrastructure status
{If infra populated: "DevOps infrastructure configured"}
{If infra empty: "Pending DevOps infrastructure configuration"}

## Before going live               <-- Only for prod-ready intent
{Smart checklist based on app-context.json}

---
*Managed by /ship-it*
```

## Prerequisites Checklist (prod-ready only)

When `app-context.json` exists, the checklist is smart -- it pre-checks items that make-it already configured:

```markdown
## Before going live

- [x] **User login (SSO)** -- already set up by /make-it with OIDC
- [ ] **Database** -- production PostgreSQL instance needed
- [ ] **Secure web address** -- SSL certificate for production URL
- [ ] **DNS setup** -- production URL (e.g., task-hub.apps.example.com)
- [ ] **Network/firewall** -- access to internal systems if needed
- [ ] **Monitoring & alerts** -- error tracking and uptime monitoring

> Your DevOps team will set up anything you check.
```

When no app-context exists, fall back to the generic checklist from `.ship-it.yml` `deployment.prerequisites`.

## Standalone Mode

`/ship-it` works without `/make-it`. When no `app-context.json` exists:
- Ask the app-type questions (web app, API, script, etc.)
- Ask "In one sentence, what does this do?"
- Auto-detect stack from project files
- Generate `.ship-it.yml` with detected values
- Everything else works the same

This means `/ship-it` is useful for ANY GitHub project, not just ones built by `/make-it`.
