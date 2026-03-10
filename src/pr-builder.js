const fs = require('fs');
const path = require('path');
const { getIntentLabel } = require('./intent');

const MANAGED_LABEL = 'ship-it-managed';

const LABEL_COLORS = {
  'intent:experiment': 'd4c5f9',
  'intent:shareable': '0e8a16',
  'intent:prod-ready': 'e11d48',
  [MANAGED_LABEL]: '1d76db'
};

/**
 * Create or update a pull request with the correct intent label,
 * description, and prerequisites checklist.
 */
async function createOrUpdatePR({ octokit, owner, repo, branch, baseBranch, intent, appInfo }) {
  // Ensure labels exist
  await ensureLabels({ octokit, owner, repo });

  const intentLabel = getIntentLabel(intent);
  const labels = [intentLabel, MANAGED_LABEL];

  // Check for an existing PR from this branch
  const existingPR = await findExistingPR({ octokit, owner, repo, branch });

  const title = buildTitle({ intent, appInfo });
  const body = buildBody({ intent, appInfo });

  let pr;
  if (existingPR) {
    // Update existing PR
    const { data } = await octokit.rest.pulls.update({
      owner, repo,
      pull_number: existingPR.number,
      title,
      body
    });
    pr = data;
  } else {
    // Create new PR
    const { data } = await octokit.rest.pulls.create({
      owner, repo,
      title,
      body,
      head: branch,
      base: baseBranch || 'main'
    });
    pr = data;
  }

  // Apply labels
  await octokit.rest.issues.addLabels({
    owner, repo,
    issue_number: pr.number,
    labels
  });

  // Request reviewers if provided
  if (appInfo.reviewer && appInfo.reviewer !== 'TBD') {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner, repo,
        pull_number: pr.number,
        reviewers: [appInfo.reviewer]
      });
    } catch {
      // Reviewer may not have access — non-blocking
    }
  }

  return { url: pr.html_url, number: pr.number, isNew: !existingPR };
}

async function findExistingPR({ octokit, owner, repo, branch }) {
  const { data: prs } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', head: `${owner}:${branch}`
  });
  return prs[0] || null;
}

async function ensureLabels({ octokit, owner, repo }) {
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    try {
      await octokit.rest.issues.createLabel({
        owner, repo, name, color, description: `Managed by /ship-it`
      });
    } catch (error) {
      // 422 = label already exists, which is fine
      if (error.status !== 422) throw error;
    }
  }
}

function buildTitle({ intent, appInfo }) {
  const prefix = `[${intent}]`;
  const desc = appInfo.description || appInfo.branch || 'Update';
  return `${prefix} ${desc}`;
}

function buildBody({ intent, appInfo }) {
  const templatePath = path.join(__dirname, '..', 'templates', 'pr-description.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  template = template.replace('{{DESCRIPTION}}', appInfo.description || 'TBD');
  template = template.replace('{{AFFECTED}}', getAffected(intent, appInfo));
  template = template.replace('{{DATA_CLASSIFICATION}}', appInfo.realData ? 'Real data' : 'Test/synthetic data only');
  template = template.replace('{{RISK}}', getRiskLine(intent, appInfo));

  // Append prod checklist if prod-ready
  if (intent === 'prod-ready') {
    const checklistPath = path.join(__dirname, '..', 'templates', 'checklist-prod.md');
    const checklist = fs.readFileSync(checklistPath, 'utf8');
    template += '\n\n' + checklist;
  }

  return template;
}

function getAffected(intent, appInfo) {
  if (intent === 'experiment') return 'Just me (developer only)';
  if (intent === 'shareable') return appInfo.othersUse ? 'Team members / demo audience' : 'TBD';
  return 'End users / production systems';
}

function getRiskLine(intent, appInfo) {
  if (intent === 'experiment') return 'Low — only affects me';
  if (intent === 'shareable') return 'Medium — others may notice if it breaks';
  return 'High — business/customer impact if something goes wrong';
}

module.exports = { createOrUpdatePR };
