const { classifyIntent, getIntentLabel, getIntentDescription, getDeploySummary, INTENTS } = require('../intent');

describe('classifyIntent', () => {
  test('returns prod-ready when real data is involved', () => {
    expect(classifyIntent({ othersUse: false, realData: true, impactIfBroken: false }))
      .toBe(INTENTS.PROD_READY);
  });

  test('returns prod-ready when breakage impacts others', () => {
    expect(classifyIntent({ othersUse: false, realData: false, impactIfBroken: true }))
      .toBe(INTENTS.PROD_READY);
  });

  test('returns prod-ready when both real data and impact', () => {
    expect(classifyIntent({ othersUse: true, realData: true, impactIfBroken: true }))
      .toBe(INTENTS.PROD_READY);
  });

  test('returns shareable when others will use it but low risk', () => {
    expect(classifyIntent({ othersUse: true, realData: false, impactIfBroken: false }))
      .toBe(INTENTS.SHAREABLE);
  });

  test('returns experiment when all answers are no', () => {
    expect(classifyIntent({ othersUse: false, realData: false, impactIfBroken: false }))
      .toBe(INTENTS.EXPERIMENT);
  });
});

describe('getIntentLabel', () => {
  test('returns correct label for each intent', () => {
    expect(getIntentLabel(INTENTS.EXPERIMENT)).toBe('intent:experiment');
    expect(getIntentLabel(INTENTS.SHAREABLE)).toBe('intent:shareable');
    expect(getIntentLabel(INTENTS.PROD_READY)).toBe('intent:prod-ready');
  });

  test('returns null for unknown intent', () => {
    expect(getIntentLabel('nonsense')).toBeNull();
  });
});

describe('getIntentDescription', () => {
  test('returns a non-empty string for each intent', () => {
    expect(getIntentDescription(INTENTS.EXPERIMENT).length).toBeGreaterThan(0);
    expect(getIntentDescription(INTENTS.SHAREABLE).length).toBeGreaterThan(0);
    expect(getIntentDescription(INTENTS.PROD_READY).length).toBeGreaterThan(0);
  });

  test('returns empty string for unknown intent', () => {
    expect(getIntentDescription('nonsense')).toBe('');
  });
});

describe('getDeploySummary', () => {
  test('returns 3 bullets for each intent', () => {
    expect(getDeploySummary(INTENTS.EXPERIMENT)).toHaveLength(3);
    expect(getDeploySummary(INTENTS.SHAREABLE)).toHaveLength(3);
    expect(getDeploySummary(INTENTS.PROD_READY)).toHaveLength(3);
  });

  test('returns empty array for unknown intent', () => {
    expect(getDeploySummary('nonsense')).toEqual([]);
  });
});
