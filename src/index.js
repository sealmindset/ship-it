const core = require('@actions/core');
const github = require('@actions/github');
const { classifyIntent } = require('./intent');
const { scanForBlockers } = require('./blocker-scan');
const { createOrUpdatePR } = require('./pr-builder');
const { ensureWorkflow } = require('./workflow-gen');
const { handleAuthError } = require('./auth-handler');
const { runInteractiveFlow } = require('./prompt-flow');

async function run() {
  try {
    const mode = core.getInput('mode') || 'ci';
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);
    const context = github.context;

    if (mode === 'interactive') {
      await runInteractiveFlow({ octokit, context, core });
      return;
    }

    // CI mode — runs as part of a GitHub Actions workflow on PR events
    await runCIMode({ octokit, context, core });
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      const message = handleAuthError(error);
      core.setFailed(message);
    } else {
      core.setFailed(`Something went wrong: ${error.message}`);
    }
  }
}

async function runCIMode({ octokit, context, core }) {
  const { owner, repo } = context.repo;
  const intentOverride = core.getInput('intent');

  // If triggered by a PR event, read the PR details
  const prNumber = context.payload.pull_request?.number;
  if (!prNumber) {
    core.info('No pull request found in this event. Nothing to do.');
    return;
  }

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const labels = pr.labels.map(l => l.name);

  // Determine intent from labels or override input
  let intent = intentOverride;
  if (!intent) {
    if (labels.includes('intent:prod-ready')) intent = 'prod-ready';
    else if (labels.includes('intent:shareable')) intent = 'shareable';
    else if (labels.includes('intent:experiment')) intent = 'experiment';
  }

  if (!intent) {
    core.info('No intent label found on this PR. Run /ship-it interactively to classify it first.');
    core.setOutput('intent', 'unknown');
    return;
  }

  // Scan for blockers
  const blockers = await scanForBlockers({ octokit, owner, repo, pr, branch: pr.head.ref });
  core.setOutput('intent', intent);
  core.setOutput('blockers-found', blockers.hasHardBlockers.toString());
  core.setOutput('blocker-summary', blockers.summary);

  if (blockers.hasHardBlockers) {
    core.setFailed(`Blockers found: ${blockers.summary}`);
    return;
  }

  // Set deploy target based on intent
  const deployTargets = {
    'experiment': 'none',
    'shareable': 'dev',
    'prod-ready': 'dev+prod'
  };
  core.setOutput('deploy-target', deployTargets[intent] || 'none');

  core.info(`Intent: ${intent}`);
  core.info(`Deploy target: ${deployTargets[intent]}`);
  core.info(`Blockers: ${blockers.summary || 'None'}`);
}

run();
