# /ship-it End-to-End Walkthrough

What happens when a developer types `/ship-it`. Three scenarios.

## Scenario 1: App built by /make-it (zero questions)

The developer just finished building an app with /make-it. Their project has `app-context.json`, `.make-it-state.md`, and Docker containers already running.

```
Developer: /ship-it

/ship-it: Shipping your code now...
          This is heading to production. I'll make sure everything is in place.

          **Done!** Your code is on its way.
          https://github.com/devuser/task-hub/pull/1

          The team will review it and let you know when it's live.
```

**What happened silently:**
1. Read `app-context.json` -- got app name, stack, services, auth, database
2. Read `.make-it-state.md` -- saw build-verify passed, prod-ready
3. Skipped all readiness and app-type questions
4. Skipped intent questions (state said prod-ready)
5. Generated `.ship-it.yml` with `app` section from context
6. Ensured `.gitignore` had critical entries
7. Created branch `ship-it/task-hub`
8. Committed and pushed all code
9. Generated GitHub Actions workflow (placeholder deploy steps -- no infra yet)
10. Created PR with:
    - Title: `[prod-ready] TaskHub: Team task management app`
    - Labels: `intent:prod-ready`, `ship-it-managed`
    - App details section (stack, services, auth, database)
    - Infrastructure status: "Pending DevOps configuration"
    - Smart prerequisites checklist (auth pre-checked)
11. Reported the PR URL

**Total questions asked: 0**

## Scenario 2: Standalone project (3-5 questions)

A developer has a Node.js API they built without /make-it. No `app-context.json`.

```
Developer: /ship-it

/ship-it: Shipping your code now...

          Will anyone else use this besides you -- even just to
          look at it or try it out? (yes/no)
Developer: yes

          Does it touch real data -- like actual customer info
          or company records? (yes/no)
Developer: no

          If this broke, would anyone besides you notice or be
          affected? (yes/no)
Developer: no

/ship-it: Other people will see this, so I'll set things up cleanly.

          In one sentence, what does this do?
Developer: Internal API for team schedule management

          Who should look this over before it goes live?
          (GitHub username, or press Enter to skip)
Developer: alice-devlead

          **Done!** Your code is on its way.
          https://github.com/devuser/schedule-api/pull/3

          The team will review it and let you know when it's live.
```

**Total questions asked: 5** (3 intent + 2 app info)

## Scenario 3: Save mode (zero questions)

The developer is mid-work and wants to back up their progress.

```
Developer: /ship-it save

/ship-it: Saving your work...

          **Saved!** Your work is backed up.
          Run /ship-it when you're ready to go live.
```

**What happened silently:**
1. Created branch `wip/add-auth-flow`
2. Committed all changes as "Work in progress"
3. Pushed to GitHub
4. Created draft PR: "WIP: add auth flow"

**Total questions asked: 0**

## Scenario 4: Re-run (PR already open)

Developer has an open PR and runs `/ship-it` again.

### With new changes:
```
Developer: /ship-it

/ship-it: **Updated!** Your latest changes have been added.
          https://github.com/devuser/task-hub/pull/1

          The team will take it from here.
```

### Without new changes:
```
Developer: /ship-it

/ship-it: Your request is already open: https://github.com/devuser/task-hub/pull/1
          Waiting on a review from the team.
```

## What the Developer Never Sees

- Git commands or output
- YAML files
- CI/CD configuration
- Error logs or stack traces
- Technical jargon (no "pipeline", "merge conflict", "status checks", "pull request")

## What the Developer Always Sees

- Warm, brief messages (2-3 sentences max)
- A PR URL they can click
- Plain-language status updates
- Clear next steps if something goes wrong

## Error Examples

```
/ship-it: I don't see a code project here. Make sure you're
          in the right folder and try again.
```

```
/ship-it: I can't connect to GitHub. Run `gh auth login` and
          try /ship-it again.
```

```
/ship-it: Your code is already live -- there's nothing new to
          ship. Make some changes and run /ship-it again.
```

## Question Decision Tree

```
Has app-context.json?
  ├─ YES: Skip app questions
  │       Has .make-it-state.md with prod-ready?
  │       ├─ YES: Skip intent questions → prod-ready
  │       └─ NO:  Ask 3 intent questions
  │
  └─ NO:  Ask 3 intent questions + 2 app questions
          (description, reviewer)
```

Note: The old readiness questions (Q1-Q4: "Does it run?", "Have you tested?", etc.) are removed.
When make-it context exists with build-verify passed, the app is already verified.
When no make-it context exists, we trust the developer -- they chose to ship.
