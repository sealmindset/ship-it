const { getIntentLabel } = require('./intent');

const MANAGED_LABEL = 'ship-it-managed';

const LABEL_COLORS = {
  'intent:experiment': 'd4c5f9',
  'intent:shareable': '0e8a16',
  'intent:prod-ready': 'e11d48',
  [MANAGED_LABEL]: '1d76db'
};

const DEFAULT_PREREQUISITES = [
  'Does this app need users to log in? (SSO / App registration)',
  'Does this need a secure web address? (SSL certificate)',
  'Who should have access in production? (Permissions / RBAC)',
  'Does this need a URL people can visit? (DNS setup)',
  'Does this need to talk to internal systems? (Network / firewall)'
];

/**
 * Create or update a pull request with intent label,
 * app details, infrastructure status, and prerequisites checklist.
 */
async function createOrUpdatePR({ octokit, owner, repo, branch, baseBranch, intent, appInfo, config }) {
  await ensureLabels({ octokit, owner, repo });

  const intentLabel = getIntentLabel(intent);
  const labels = [intentLabel, MANAGED_LABEL];

  const existingPR = await findExistingPR({ octokit, owner, repo, branch });

  const title = buildTitle({ intent, appInfo, config });
  const body = buildBody({ intent, appInfo, config });

  let pr;
  if (existingPR) {
    const { data } = await octokit.rest.pulls.update({
      owner, repo,
      pull_number: existingPR.number,
      title,
      body
    });
    pr = data;
  } else {
    const { data } = await octokit.rest.pulls.create({
      owner, repo,
      title,
      body,
      head: branch,
      base: baseBranch || 'main'
    });
    pr = data;
  }

  await octokit.rest.issues.addLabels({
    owner, repo,
    issue_number: pr.number,
    labels
  });

  // Request reviewers from config or appInfo
  const reviewers = getReviewers({ appInfo, config });
  if (reviewers.length > 0) {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner, repo,
        pull_number: pr.number,
        reviewers
      });
    } catch {
      // Reviewer may not have access -- non-blocking
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
        owner, repo, name, color, description: 'Managed by /ship-it'
      });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
  }
}

// --- Title ---

function buildTitle({ intent, appInfo, config }) {
  const prefix = `[${intent}]`;

  // Priority: config app name > appInfo description > branch name
  if (config?.app?.name && config.app.name !== '') {
    const desc = config.app.description || config.app.name;
    return `${prefix} ${config.app.name}: ${truncate(desc, 50)}`;
  }

  const desc = appInfo?.description || appInfo?.branch || 'Update';
  return `${prefix} ${truncate(desc, 60)}`;
}

// --- Body ---

function buildBody({ intent, appInfo, config }) {
  const sections = [];

  // What this does
  sections.push('## What this does');
  if (config?.app?.description) {
    sections.push(config.app.description);
  } else if (appInfo?.description && appInfo.description !== 'TBD') {
    sections.push(appInfo.description);
  } else {
    sections.push('TBD');
  }

  // App details (only if make-it context or ship-it.yml app section exists)
  if (config?.context?.hasMakeIt || config?.app?.stack) {
    sections.push('');
    sections.push('## App details');
    const details = [];
    if (config.app.stack) details.push(`- **Stack:** ${config.app.stack}`);
    if (config.app.services.length > 0) {
      const svcList = config.app.services.map(s => `${s.name} (:${s.port})`).join(', ');
      details.push(`- **Services:** ${svcList}`);
    }
    if (config.app.auth.provider !== 'none') {
      details.push(`- **Auth:** ${config.app.auth.provider}`);
    }
    if (config.app.database.engine !== 'none') {
      details.push(`- **Database:** ${config.app.database.engine}${config.app.database.version ? ' ' + config.app.database.version : ''}`);
    }
    sections.push(details.join('\n'));
  }

  // Who's affected
  sections.push('');
  sections.push('## Who\'s affected');
  sections.push(getAffected(intent, appInfo));

  // Data involved
  sections.push('');
  sections.push('## Data involved');
  sections.push(appInfo?.realData ? 'Real data' : 'Test/synthetic data only');

  // Risk
  sections.push('');
  sections.push('## Risk if something goes wrong');
  sections.push(getRiskLine(intent));

  // Infrastructure status
  sections.push('');
  sections.push('## Infrastructure status');
  if (config?.infra?.configured) {
    sections.push('DevOps infrastructure configured ✓');
    if (config.infra.provider === 'aws') {
      const aws = config.infra.aws || {};
      sections.push(`- **Provider:** AWS (${aws.region || 'us-east-1'})`);
      if (aws.ecs?.cluster_name) sections.push(`- **Cluster:** ${aws.ecs.cluster_name}`);
      if (aws.dns?.domain && config.app.slug) sections.push(`- **URL:** ${config.app.slug}.${aws.dns.domain}`);
    } else if (config.infra.provider === 'azure') {
      const az = config.infra.azure || {};
      sections.push(`- **Provider:** Azure`);
      if (az.aks?.cluster_name) sections.push(`- **Cluster:** ${az.aks.cluster_name}`);
      if (az.dns?.zone_name && config.app.slug) sections.push(`- **URL:** ${config.app.slug}.${az.dns.zone_name}`);
    }
  } else {
    sections.push('⚠️ Pending DevOps infrastructure configuration -- fill in the `infra` section of `.ship-it.yml`');
    sections.push('');
    sections.push('See the [DevOps onboarding guide](https://github.com/sealmindset/ship-it/blob/main/docs/devops-guide.md) for instructions.');
  }

  // Prerequisites checklist (prod-ready only)
  if (intent === 'prod-ready') {
    sections.push('');
    sections.push(buildChecklist(config));
  }

  sections.push('');
  sections.push('---');
  sections.push('*Managed by /ship-it*');

  return sections.join('\n');
}

// --- Checklist ---

function buildChecklist(config) {
  const lines = ['## Before going live'];
  lines.push('');
  lines.push('Check the box if your app needs this. DevOps/platform will handle the setup.');
  lines.push('');

  // If config has custom prerequisites, use those
  if (config?.deployment?.prerequisites?.length > 0) {
    for (const prereq of config.deployment.prerequisites) {
      lines.push(`- [ ] ${prereq}`);
    }
    lines.push('');
    lines.push('> Your DevOps team will set up anything you check.');
    return lines.join('\n');
  }

  // Smart checklist based on app-context
  const app = config?.app || {};

  // Auth -- pre-check if already configured
  if (app.auth?.provider && app.auth.provider !== 'none') {
    lines.push(`- [x] **User login (SSO)** -- already set up with ${app.auth.provider}`);
  } else {
    lines.push('- [ ] **User login (SSO)** -- does this app need users to log in?');
  }

  // Database -- needs production instance
  if (app.database?.engine && app.database.engine !== 'none') {
    lines.push(`- [ ] **Database** -- production ${app.database.engine} instance needed`);
  }

  // SSL
  lines.push('- [ ] **Secure web address** -- SSL certificate for production URL');

  // DNS
  if (config?.infra?.configured && config.infra.provider === 'aws' && config.infra.aws?.dns?.domain) {
    lines.push(`- [x] **DNS setup** -- ${app.slug || 'app'}.${config.infra.aws.dns.domain}`);
  } else if (config?.infra?.configured && config.infra.provider === 'azure' && config.infra.azure?.dns?.zone_name) {
    lines.push(`- [x] **DNS setup** -- ${app.slug || 'app'}.${config.infra.azure.dns.zone_name}`);
  } else {
    lines.push('- [ ] **DNS setup** -- production URL needed');
  }

  // Network
  lines.push('- [ ] **Network/firewall** -- access to internal systems if needed');

  // Monitoring
  lines.push('- [ ] **Monitoring & alerts** -- error tracking and uptime monitoring');

  // Infra config itself
  if (!config?.infra?.configured) {
    lines.push('- [ ] **DevOps infrastructure** -- fill in the `infra` section of `.ship-it.yml`');
  }

  lines.push('');
  lines.push('> Your DevOps team will set up anything you check.');

  return lines.join('\n');
}

// --- Helpers ---

function getReviewers({ appInfo, config }) {
  // Config reviewers take priority
  if (config?.deployment?.reviewers?.length > 0) {
    return config.deployment.reviewers;
  }
  // Fall back to appInfo.reviewer
  if (appInfo?.reviewer && appInfo.reviewer !== 'TBD') {
    return [appInfo.reviewer];
  }
  return [];
}

function getAffected(intent, appInfo) {
  if (intent === 'experiment') return 'Just me (developer only)';
  if (intent === 'shareable') return appInfo?.othersUse ? 'Team members / demo audience' : 'TBD';
  return 'End users / production systems';
}

function getRiskLine(intent) {
  if (intent === 'experiment') return 'Low -- only affects me';
  if (intent === 'shareable') return 'Medium -- others may notice if it breaks';
  return 'High -- business/customer impact if something goes wrong';
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

module.exports = { createOrUpdatePR };
