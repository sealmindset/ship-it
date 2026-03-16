const { classifyIntent, getIntentDescription, getDeploySummary, getIntentLabel } = require('./intent');
const { scanForBlockers } = require('./blocker-scan');
const { createOrUpdatePR } = require('./pr-builder');
const { ensureWorkflow } = require('./workflow-gen');
const { loadConfig, generateShipItYml } = require('./config-loader');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

/**
 * Runs the full interactive CLI Q&A flow.
 * This is the heart of /ship-it -- it walks the developer through
 * readiness checks, blocker detection, intent classification, and
 * the final push, using plain-language questions.
 *
 * When make-it context exists (app-context.json), it skips app
 * questions and auto-populates the config.
 */
async function runInteractiveFlow({ octokit, context, core }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  const { owner, repo } = context.repo;
  const branch = context.ref?.replace('refs/heads/', '') || 'unknown';
  const workingDir = core.getInput('working-directory') || '.';

  try {
    // --- Load config (merge .ship-it.yml + app-context.json + auto-detect) ---
    const config = loadConfig({ workingDir });

    // --- Step 1: Greeting ---
    print(`\nHey! I'm here to help you get your code shipped.`);
    print(`I can see you're working on ${owner}/${repo} on the "${branch}" branch.`);

    if (config.context.hasMakeIt) {
      print(`I found your app details from /make-it -- I already know about ${config.app.name || 'your app'}.`);
    }

    print(`Let's figure out what needs to happen next.\n`);

    // --- Step 2: Readiness Questions ---
    // Skip readiness questions if build-verify passed
    let ready = { canProceed: true };
    if (!config.context.buildVerified) {
      ready = await askReadinessQuestions(ask);
      if (!ready.canProceed) {
        print(`\nSounds like there's still some work to do. No rush -- run /ship-it again when you're ready.\n`);
        rl.close();
        return;
      }
    } else {
      print(`Your app passed all checks from /make-it -- skipping readiness questions.\n`);
    }

    // --- Step 3: Blocker Scan ---
    print(`Checking for anything that might get in the way...`);
    const pr = context.payload?.pull_request;
    let blockers = { hard: [], soft: [], hasHardBlockers: false, summary: 'No blockers found.' };

    if (pr) {
      blockers = await scanForBlockers({ octokit, owner, repo, pr, branch });
    }

    if (blockers.hasHardBlockers) {
      print(`\nI found some issues that need to be fixed first:`);
      blockers.hard.forEach(b => print(`  - ${b}`));
      print(`\nFix these and run /ship-it again.\n`);
      rl.close();
      return;
    }

    if (blockers.soft.length > 0) {
      print(`\nHeads up -- a few things to be aware of:`);
      blockers.soft.forEach(b => print(`  - ${b}`));
      const proceed = await ask(`\nWant to keep going anyway? (yes/no) `);
      if (normalizeAnswer(proceed) === false) {
        print(`No problem. Handle those and come back when ready.\n`);
        rl.close();
        return;
      }
    } else {
      print(`All clear -- no blockers found.`);
    }

    // --- Step 4: Intent Classification ---
    // Shortcut: if build-verify passed and user said prod-ready, skip intent questions
    let intent;
    let intentAnswers = {};

    if (config.context.prodReady) {
      intent = 'prod-ready';
      intentAnswers = { othersUse: true, realData: true, impactIfBroken: true };
      print(`\nYour app was marked as production-ready -- setting up the full safety treatment.`);
    } else {
      print(`\nNow I need to understand what kind of change this is.\n`);
      intentAnswers = await askIntentQuestions(ask);
      intent = classifyIntent(intentAnswers);
    }

    const intentDesc = getIntentDescription(intent);
    const deploySummary = getDeploySummary(intent);

    print(`\n>> ${intentDesc}\n`);
    print(`Here's what will happen:`);
    deploySummary.forEach(s => print(`  - ${s}`));

    // --- Step 5: Collect App Info ---
    // Skip app questions if make-it context exists
    let appInfo;
    if (config.context.hasMakeIt) {
      print(`\nUsing your app details from /make-it -- no extra questions needed.`);
      appInfo = {
        description: config.app.description || config.app.name,
        appType: config.app.projectType || 'Web app',
        runtime: 'Container',
        reviewer: config.deployment.reviewers[0] || 'TBD',
        branch,
        ...intentAnswers
      };
    } else {
      print('');
      appInfo = await collectAppInfo(ask, { branch, ...intentAnswers });
    }

    // --- Step 5A: Auto-generate .ship-it.yml if needed ---
    if (!config.context.hasShipItYml && config.context.hasMakeIt) {
      print(`\nGenerating deployment config from your app details...`);
      const ymlContent = generateShipItYml(config);
      fs.writeFileSync(path.join(workingDir, '.ship-it.yml'), ymlContent);
      print(`  Created .ship-it.yml`);
    }

    // --- Step 5B: Workflow Generation ---
    print(`\nSetting things up...`);
    const wf = await ensureWorkflow({ octokit, owner, repo, branch, config });
    print(`  ${wf.message}`);

    // --- Step 5C: Create PR ---
    const prResult = await createOrUpdatePR({
      octokit, owner, repo, branch, baseBranch: 'main', intent, appInfo, config
    });

    // --- Step 6: Summary ---
    print(`\nDone! Here's what I did:`);
    print(`  - ${prResult.isNew ? 'Created' : 'Updated'} a pull request: ${prResult.url}`);
    print(`  - Applied the label: ${getIntentLabel(intent)}`);
    deploySummary.forEach(s => print(`  - ${s}`));
    if (intent === 'prod-ready') {
      print(`  - Added a checklist of things to handle before go-live`);
    }
    if (!config.infra.configured) {
      print(`  - Note: deployment steps are placeholders until DevOps fills in the infra section`);
    }
    print(`\nYou're all set. When the PR is approved and merged, the automation takes it from there.\n`);

    // Set outputs
    core.setOutput('intent', intent);
    core.setOutput('pr-url', prResult.url);
    core.setOutput('pr-number', prResult.number.toString());
    core.setOutput('deploy-target', intent === 'prod-ready' ? 'dev+prod' : intent === 'shareable' ? 'dev' : 'none');
  } finally {
    rl.close();
  }
}

async function askReadinessQuestions(ask) {
  const q1 = await ask('Does your app run without errors right now? (yes/no) ');
  if (normalizeAnswer(q1) === false) {
    return { canProceed: false };
  }

  const q2 = await ask('Have you tested the main things it\'s supposed to do? (yes/no) ');

  const q3 = await ask('Is there anything you know is broken or half-finished? (yes/no) ');
  if (normalizeAnswer(q3) === true) {
    return { canProceed: false };
  }

  const q4 = await ask('Are you the only one working on this, or is someone else making changes too? (just me / someone else too) ');
  const hasCollaborators = q4.toLowerCase().includes('someone') || q4.toLowerCase().includes('else');

  return { canProceed: true, tested: normalizeAnswer(q2), hasCollaborators };
}

async function askIntentQuestions(ask) {
  const q1 = await ask('Will anyone else use this besides you -- even just to look at it or try it out? (yes/no) ');
  const q2 = await ask('Does it touch real data -- like actual customer info, company records, or anything that\'s not made-up test data? (yes/no) ');
  const q3 = await ask('If this broke, would anyone besides you notice or be affected? (yes/no) ');

  return {
    othersUse: normalizeAnswer(q1),
    realData: normalizeAnswer(q2),
    impactIfBroken: normalizeAnswer(q3)
  };
}

async function collectAppInfo(ask, defaults) {
  const description = await ask('In one sentence, what does this do? ');

  const appTypeAnswer = await ask('What kind of app is this? (1) Web app  (2) API  (3) Script/automation  (4) Something else: ');
  const appTypes = { '1': 'Web app', '2': 'API', '3': 'Script/automation', '4': 'Other' };
  const appType = appTypes[appTypeAnswer.trim()] || appTypeAnswer.trim() || 'TBD';

  const runtimeAnswer = await ask('Where should this run? (1) Container  (2) Serverless function  (3) Web hosting  (4) Not sure: ');
  const runtimes = { '1': 'Container', '2': 'Serverless function', '3': 'Web hosting', '4': 'TBD' };
  const runtime = runtimes[runtimeAnswer.trim()] || runtimeAnswer.trim() || 'TBD';

  const reviewer = await ask('Who should look this over before it goes live? (GitHub username, or press Enter to skip) ');

  return {
    description: description.trim() || 'TBD',
    appType,
    runtime,
    reviewer: reviewer.trim() || 'TBD',
    branch: defaults.branch,
    othersUse: defaults.othersUse,
    realData: defaults.realData,
    impactIfBroken: defaults.impactIfBroken
  };
}

function normalizeAnswer(answer) {
  const a = (answer || '').trim().toLowerCase();
  if (['yes', 'y', 'yeah', 'yep', 'sure', 'true'].includes(a)) return true;
  if (['no', 'n', 'nah', 'nope', 'false'].includes(a)) return false;
  return null;
}

function print(msg) {
  console.log(msg);
}

module.exports = { runInteractiveFlow };
