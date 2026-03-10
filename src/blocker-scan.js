/**
 * Scans the repo for blockers that would prevent a clean ship.
 * Returns plain-language summaries — never raw API output.
 */
async function scanForBlockers({ octokit, owner, repo, pr, branch }) {
  const results = {
    hard: [],
    soft: [],
    hasHardBlockers: false,
    summary: ''
  };

  await Promise.all([
    checkOpenPRs({ octokit, owner, repo, pr, branch, results }),
    checkLinkedIssues({ octokit, owner, repo, pr, results }),
    checkStatusChecks({ octokit, owner, repo, branch, results }),
    checkMergeConflicts({ pr, results }),
    checkWorkflowExists({ octokit, owner, repo, branch, results })
  ]);

  results.hasHardBlockers = results.hard.length > 0;
  results.summary = formatSummary(results);

  return results;
}

async function checkOpenPRs({ octokit, owner, repo, pr, branch, results }) {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner, repo, state: 'open', base: pr.base.ref
    });
    const otherPRs = prs.filter(p => p.number !== pr.number);
    if (otherPRs.length > 0) {
      results.soft.push(
        `There are ${otherPRs.length} other open change(s) heading to the same place. ` +
        `You might want to check with your team before pushing yours.`
      );
    }
  } catch {
    // Non-critical — skip silently
  }
}

async function checkLinkedIssues({ octokit, owner, repo, pr, results }) {
  try {
    const { data: timeline } = await octokit.rest.issues.listEventsForTimeline({
      owner, repo, issue_number: pr.number
    });
    const linkedIssues = timeline.filter(
      e => e.event === 'cross-referenced' && e.source?.issue?.state === 'open'
    );
    if (linkedIssues.length > 0) {
      results.soft.push(
        `I found ${linkedIssues.length} open issue(s) linked to your work. ` +
        `Want to keep going anyway, or handle those first?`
      );
    }
  } catch {
    // Timeline API may not be available — skip
  }
}

async function checkStatusChecks({ octokit, owner, repo, branch, results }) {
  try {
    const { data: status } = await octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: branch
    });
    const failing = status.statuses.filter(s => s.state === 'failure' || s.state === 'error');
    if (failing.length > 0) {
      const names = failing.map(s => s.context).join(', ');
      results.soft.push(
        `Some automated checks are failing on your branch: ${names}. ` +
        `Want me to try pushing anyway, or fix these first?`
      );
    }
  } catch {
    // No status checks configured — that's fine
  }
}

async function checkMergeConflicts({ pr, results }) {
  if (pr.mergeable === false) {
    results.hard.push(
      `Your code has some conflicts with the latest version of ${pr.base.ref}. ` +
      `You'll need to sort those out before I can push. Want some help with that?`
    );
  }
}

async function checkWorkflowExists({ octokit, owner, repo, branch, results }) {
  try {
    await octokit.rest.repos.getContent({
      owner, repo, path: '.github/workflows', ref: branch
    });
  } catch (error) {
    if (error.status === 404) {
      results.soft.push(
        `I don't see any automation set up for this repo yet. ` +
        `I can create a basic one for you. Sound good?`
      );
    }
  }
}

function formatSummary(results) {
  const all = [...results.hard, ...results.soft];
  if (all.length === 0) return 'No blockers found. You are clear to ship.';
  return all.join('\n');
}

module.exports = { scanForBlockers };
