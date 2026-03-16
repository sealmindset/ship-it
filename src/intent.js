const INTENTS = {
  EXPERIMENT: 'experiment',
  SHAREABLE: 'shareable',
  PROD_READY: 'prod-ready'
};

const INTENT_LABELS = {
  [INTENTS.EXPERIMENT]: 'intent:experiment',
  [INTENTS.SHAREABLE]: 'intent:shareable',
  [INTENTS.PROD_READY]: 'intent:prod-ready'
};

const INTENT_DESCRIPTIONS = {
  [INTENTS.EXPERIMENT]: "This is just for you right now. I'll keep things simple.",
  [INTENTS.SHAREABLE]: "Other people will see this, so I'll set things up cleanly.",
  [INTENTS.PROD_READY]: "This is heading to production. I'll make sure everything is in place."
};

const INTENT_DEPLOY_SUMMARY = {
  [INTENTS.EXPERIMENT]: [
    'Run basic checks on your code',
    'No deployment — this stays in your personal space',
    'You can promote it later when ready'
  ],
  [INTENTS.SHAREABLE]: [
    'Run checks on your code',
    'Deploy to a test/dev environment so others can try it',
    'No production access — safe to experiment'
  ],
  [INTENTS.PROD_READY]: [
    'Run all checks including security scanning',
    'Deploy to test/dev first for validation',
    'After approval, promote the exact same build to production'
  ]
};

/**
 * Classify intent based on the three yes/no answers.
 *
 * Q1: Will anyone else use this besides you?
 * Q2: Does it touch real data (customer/enterprise, not test data)?
 * Q3: If it broke, would anyone besides you notice or be affected?
 *
 * Decision:
 *   Q2=yes OR Q3=yes  -> prod-ready
 *   Q1=yes             -> shareable
 *   all no              -> experiment
 */
function classifyIntent({ othersUse, realData, impactIfBroken }) {
  if (realData || impactIfBroken) return INTENTS.PROD_READY;
  if (othersUse) return INTENTS.SHAREABLE;
  return INTENTS.EXPERIMENT;
}

function getIntentLabel(intent) {
  return INTENT_LABELS[intent] || null;
}

function getIntentDescription(intent) {
  return INTENT_DESCRIPTIONS[intent] || '';
}

function getDeploySummary(intent) {
  return INTENT_DEPLOY_SUMMARY[intent] || [];
}

module.exports = {
  INTENTS,
  INTENT_LABELS,
  classifyIntent,
  getIntentLabel,
  getIntentDescription,
  getDeploySummary
};
