const { classifyIntent, getIntentLabel } = require('./intent');
const { scanForBlockers } = require('./blocker-scan');
const { createOrUpdatePR } = require('./pr-builder');
const { ensureWorkflow } = require('./workflow-gen');
const { loadConfig, generateShipItYml } = require('./config-loader');
const { generateGitignore, getMissingEntries } = require('./gitignore-gen');
const { auditDependencies, formatAuditSummary } = require('./dep-audit');
const { exec } = require('@actions/exec');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

/**
 * Entry point for interactive /ship-it.
 * Detects mode from arguments: "save" -> save mode, default -> ship mode.
 * Re-run mode is triggered automatically when an open PR is detected.
 */
async function runInteractiveFlow({ octokit, context, core }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  const { owner, repo } = context.repo;
  const workingDir = core.getInput('working-directory') || '.';
  const args = core.getInput('arguments') || '';

  try {
    // Detect mode
    if (args.toLowerCase().includes('save')) {
      await runSaveMode({ octokit, owner, repo, workingDir, core });
    } else {
      await runShipMode({ octokit, owner, repo, workingDir, ask, core });
    }
  } finally {
    rl.close();
  }
}

// ═══════════════════════════════════════════════════════════
// SHIP MODE (default)
// ═══════════════════════════════════════════════════════════

async function runShipMode({ octokit, owner, repo, workingDir, ask, core }) {
  // --- Silent preflight ---
  const preflight = await runPreflight(workingDir);

  if (preflight.error) {
    print(preflight.error);
    return;
  }

  // Load merged config
  const config = loadConfig({ workingDir });

  // Check for existing open PR -> re-run mode
  if (preflight.openPR) {
    await runReRunMode({ octokit, owner, repo, workingDir, preflight, core });
    return;
  }

  // Check for uncommitted changes or new commits
  if (!preflight.hasChanges && !preflight.hasUnpushed) {
    print(`Your code is already live -- there's nothing new to ship. Make some changes and run /ship-it again.`);
    return;
  }

  print(`Shipping your code now...`);

  // --- Intent classification ---
  let intent;
  let intentAnswers = {};

  if (config.context.prodReady) {
    // Shortcut: build-verify passed and marked prod-ready
    intent = 'prod-ready';
    intentAnswers = { othersUse: true, realData: true, impactIfBroken: true };
  } else {
    intentAnswers = await askIntentQuestions(ask);
    intent = classifyIntent(intentAnswers);
  }

  // Brief intent confirmation
  const intentMessages = {
    'experiment': `This is just for you right now. I'll keep things simple.`,
    'shareable': `Other people will see this, so I'll set things up cleanly.`,
    'prod-ready': `This is heading to production. I'll make sure everything is in place.`
  };
  print(intentMessages[intent]);

  // --- Build app info (skip questions if make-it context exists) ---
  let appInfo;
  if (config.context.hasMakeIt) {
    appInfo = {
      description: config.app.description || config.app.name,
      appType: config.app.projectType || 'Web app',
      runtime: 'Container',
      reviewer: (config.deployment.reviewers && config.deployment.reviewers[0]) || '',
      branch: preflight.branch,
      ...intentAnswers
    };
  } else {
    appInfo = await collectAppInfo(ask, { branch: preflight.branch, ...intentAnswers });
  }

  // --- Do everything silently ---
  try {
    // Auto-generate .ship-it.yml if needed
    if (!config.context.hasShipItYml && config.context.hasMakeIt) {
      const ymlContent = generateShipItYml(config);
      fs.writeFileSync(path.join(workingDir, '.ship-it.yml'), ymlContent);
    }

    // Ensure .gitignore exists with critical entries
    await ensureGitignore(workingDir, config.app.stack || config.context.detectedStack);

    // Pre-push security scan: audit dependencies for known vulnerabilities
    print('Checking your dependencies for known security issues...');
    let auditResult;
    try {
      auditResult = await auditDependencies({ workingDir, log: (msg) => print(msg) });
      if (auditResult.fixedCount > 0) {
        print(`Fixed ${auditResult.fixedCount} security ${auditResult.fixedCount === 1 ? 'issue' : 'issues'} in your dependencies.`);
      } else if (auditResult.vulnCount === 0 && !auditResult.skipped) {
        print('No known vulnerabilities found.');
      }
      if (auditResult.remaining > 0) {
        print(`Note: ${auditResult.remaining} ${auditResult.remaining === 1 ? 'vulnerability requires' : 'vulnerabilities require'} manual review.`);
      }
    } catch {
      auditResult = { vulnCount: 0, fixedCount: 0, remaining: 0, fixes: [], warnings: [], skipped: true };
    }

    // Branch: if on main, create ship-it/{slug} branch
    let branch = preflight.branch;
    if (branch === 'main' || branch === 'master') {
      const slug = generateBranchSlug(config, preflight);
      branch = `ship-it/${slug}`;
      await execSilent(`git checkout -b ${branch}`, workingDir);
    }

    // Commit + push
    await execSilent(
      `git add -A && git commit -m "Latest changes" 2>/dev/null; git push -u origin ${branch} 2>&1`,
      workingDir
    );

    // Workflow generation
    await ensureWorkflow({ octokit, owner, repo, branch, config });

    // Labels + PR
    const auditSummary = auditResult ? formatAuditSummary(auditResult) : '';
    const prResult = await createOrUpdatePR({
      octokit, owner, repo, branch, baseBranch: 'main', intent, appInfo, config, auditSummary
    });

    // Set outputs
    core.setOutput('intent', intent);
    core.setOutput('pr-url', prResult.url);
    core.setOutput('pr-number', prResult.number.toString());
    core.setOutput('deploy-target', intent === 'prod-ready' ? 'dev+prod' : intent === 'shareable' ? 'dev' : 'none');

    // --- Done ---
    print(`\n**Done!** Your code is on its way.`);
    print(prResult.url);
    print(`\nThe team will review it and let you know when it's live.`);

  } catch (error) {
    print(`Something went wrong while setting things up. Here's what happened:`);
    print(`  ${plainError(error)}`);
    print(`\nTry running /ship-it again. If it keeps failing, check your GitHub access with: gh auth status`);
  }
}

// ═══════════════════════════════════════════════════════════
// SAVE MODE (/ship-it save)
// ═══════════════════════════════════════════════════════════

async function runSaveMode({ octokit, owner, repo, workingDir, core }) {
  const preflight = await runPreflight(workingDir);

  if (preflight.error) {
    print(preflight.error);
    return;
  }

  print(`Saving your work...`);

  try {
    let branch = preflight.branch;

    // Create wip branch if on main
    if (branch === 'main' || branch === 'master') {
      const slug = generateBranchSlug(null, preflight);
      branch = `wip/${slug}`;
      await execSilent(`git checkout -b ${branch}`, workingDir);
    }

    // Commit + push
    await execSilent(
      `git add -A && git commit -m "Work in progress" 2>/dev/null; git push -u origin ${branch} 2>&1`,
      workingDir
    );

    // Create draft PR if none exists
    if (!preflight.openPR) {
      const description = await getShortDescription(workingDir);
      try {
        await octokit.rest.pulls.create({
          owner, repo,
          title: `WIP: ${description}`,
          body: 'Work in progress -- not ready for review yet.\n\n---\n*Managed by /ship-it*',
          head: branch,
          base: 'main',
          draft: true
        });
      } catch {
        // Draft PR creation failed -- non-blocking
      }
    }

    core.setOutput('intent', 'save');
    core.setOutput('deploy-target', 'none');

    print(`\n**Saved!** Your work is backed up.`);
    print(`Run /ship-it when you're ready to go live.`);

  } catch (error) {
    print(`I couldn't save your work: ${plainError(error)}`);
    print(`Try running: git push`);
  }
}

// ═══════════════════════════════════════════════════════════
// RE-RUN MODE (open PR already exists)
// ═══════════════════════════════════════════════════════════

async function runReRunMode({ octokit, owner, repo, workingDir, preflight, core }) {
  const pr = preflight.openPR;

  if (preflight.hasChanges) {
    // Commit and push new changes
    try {
      await execSilent(
        `git add -A && git commit -m "Latest changes" 2>/dev/null; git push 2>&1`,
        workingDir
      );

      core.setOutput('pr-url', pr.url);
      core.setOutput('pr-number', pr.number.toString());

      print(`\n**Updated!** Your latest changes have been added.`);
      print(pr.url);
      print(`\nThe team will take it from here.`);
    } catch (error) {
      print(`I couldn't push your changes: ${plainError(error)}`);
    }
    return;
  }

  // No new changes -- check PR status
  try {
    const { data: prData } = await octokit.rest.pulls.get({
      owner, repo, pull_number: pr.number
    });

    const reviews = await getReviewStatus(octokit, owner, repo, pr.number);
    const checks = await getCheckStatus(octokit, owner, repo, prData.head.sha);

    core.setOutput('pr-url', pr.url);
    core.setOutput('pr-number', pr.number.toString());

    print(`\nYour request is already open: ${pr.url}`);

    if (reviews === 'approved') {
      print(`It's been approved -- should be going live soon.`);
    } else if (checks === 'failing') {
      print(`There might be an issue -- the team will let you know.`);
    } else if (reviews === 'changes_requested') {
      print(`The team has some feedback -- check the link above for details.`);
    } else if (reviews === 'pending') {
      print(`Waiting on a review from the team.`);
    } else {
      print(`Everything looks good so far.`);
    }
  } catch {
    print(`\nYour request is already open: ${pr.url}`);
    print(`Everything looks good so far.`);
  }
}

// ═══════════════════════════════════════════════════════════
// PREFLIGHT
// ═══════════════════════════════════════════════════════════

async function runPreflight(workingDir) {
  const result = {
    branch: null,
    hasChanges: false,
    hasUnpushed: false,
    openPR: null,
    error: null
  };

  // Check: is this a git repo?
  if (!fs.existsSync(path.join(workingDir, '.git'))) {
    result.error = `I don't see a code project here. Make sure you're in the right folder and try again.`;
    return result;
  }

  // Get branch name
  try {
    result.branch = await execCapture('git branch --show-current', workingDir);
  } catch {
    result.error = `I can't read this project. Make sure you're in the right folder.`;
    return result;
  }

  // Check: gh CLI installed?
  try {
    await execCapture('gh --version', workingDir);
  } catch {
    result.error = `I need the GitHub CLI to continue. Install it with \`brew install gh\` (Mac) or \`sudo apt install gh\` (Linux), then try again.`;
    return result;
  }

  // Check: gh authenticated?
  try {
    await execCapture('gh auth status 2>&1', workingDir);
  } catch {
    result.error = `I can't connect to GitHub. Run \`gh auth login\` and try /ship-it again.`;
    return result;
  }

  // Check: uncommitted changes?
  try {
    const status = await execCapture('git status --porcelain', workingDir);
    result.hasChanges = status.trim().length > 0;
  } catch {}

  // Check: unpushed commits?
  try {
    const unpushed = await execCapture('git log @{u}..HEAD --oneline 2>/dev/null', workingDir);
    result.hasUnpushed = unpushed.trim().length > 0;
  } catch {
    // No upstream -- that's fine, we'll push
    result.hasUnpushed = true;
  }

  // Check: open PR from this branch?
  try {
    const prJson = await execCapture(
      `gh pr list --head "${result.branch}" --state open --json number,title,url --limit 1`,
      workingDir
    );
    const prs = JSON.parse(prJson);
    if (prs.length > 0) {
      result.openPR = prs[0];
    }
  } catch {}

  return result;
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

async function askIntentQuestions(ask) {
  print('');
  const q1 = await ask('Will anyone else use this besides you -- even just to look at it or try it out? (yes/no) ');
  const q2 = await ask('Does it touch real data -- like actual customer info or company records? (yes/no) ');
  const q3 = await ask('If this broke, would anyone besides you notice or be affected? (yes/no) ');

  return {
    othersUse: normalizeAnswer(q1),
    realData: normalizeAnswer(q2),
    impactIfBroken: normalizeAnswer(q3)
  };
}

async function collectAppInfo(ask, defaults) {
  print('');
  const description = await ask('In one sentence, what does this do? ');
  const reviewer = await ask('Who should look this over before it goes live? (GitHub username, or press Enter to skip) ');

  return {
    description: description.trim() || 'TBD',
    appType: 'TBD',
    runtime: 'TBD',
    reviewer: reviewer.trim() || '',
    branch: defaults.branch,
    othersUse: defaults.othersUse,
    realData: defaults.realData,
    impactIfBroken: defaults.impactIfBroken
  };
}

function generateBranchSlug(config, preflight) {
  // Use app name if available
  if (config?.app?.slug) {
    return config.app.slug.slice(0, 25);
  }

  // Fall back to last commit message
  try {
    const msg = require('child_process')
      .execSync('git log -1 --pretty=%s', { encoding: 'utf8' })
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 25);
    return msg || 'update';
  } catch {
    return 'update';
  }
}

async function ensureGitignore(workingDir, stack) {
  const gitignorePath = path.join(workingDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    // Generate new .gitignore
    const content = generateGitignore(stack || 'default');
    fs.writeFileSync(gitignorePath, content);
    return;
  }

  // Check for missing critical entries
  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const missing = getMissingEntries(existing, stack || 'default');

  if (missing.length > 0) {
    const additions = '\n# Added by /ship-it\n' + missing.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, additions);
  }
}

async function getShortDescription(workingDir) {
  try {
    return await execCapture('git log -1 --pretty=%s', workingDir);
  } catch {
    return 'latest changes';
  }
}

async function getReviewStatus(octokit, owner, repo, prNumber) {
  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner, repo, pull_number: prNumber
    });
    if (reviews.some(r => r.state === 'APPROVED')) return 'approved';
    if (reviews.some(r => r.state === 'CHANGES_REQUESTED')) return 'changes_requested';
    if (reviews.length > 0) return 'pending';
    return 'none';
  } catch {
    return 'unknown';
  }
}

async function getCheckStatus(octokit, owner, repo, sha) {
  try {
    const { data: status } = await octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: sha
    });
    if (status.state === 'failure') return 'failing';
    if (status.state === 'success') return 'passing';
    return 'pending';
  } catch {
    return 'unknown';
  }
}

function normalizeAnswer(answer) {
  const a = (answer || '').trim().toLowerCase();
  if (['yes', 'y', 'yeah', 'yep', 'sure', 'true', '1'].includes(a)) return true;
  if (['no', 'n', 'nah', 'nope', 'false', '0'].includes(a)) return false;
  return null;
}

function plainError(error) {
  if (error.status === 401 || error.status === 403) {
    return 'GitHub access was denied. Run `gh auth login` to fix this.';
  }
  if (error.message?.includes('rate limit')) {
    return 'GitHub is asking us to slow down. Try again in a few minutes.';
  }
  if (error.message?.includes('conflict')) {
    return 'Your code has some conflicts with the latest version. You\'ll need to sort those out first.';
  }
  return error.message || 'Unknown error';
}

/**
 * Execute a command silently and return stdout.
 */
async function execCapture(command, cwd) {
  let output = '';
  await exec('bash', ['-c', command], {
    cwd,
    silent: true,
    listeners: {
      stdout: (data) => { output += data.toString(); }
    }
  });
  return output.trim();
}

/**
 * Execute a command silently, ignoring output.
 */
async function execSilent(command, cwd) {
  await exec('bash', ['-c', command], {
    cwd,
    silent: true,
    ignoreReturnCode: true
  });
}

function print(msg) {
  console.log(msg);
}

module.exports = { runInteractiveFlow };
