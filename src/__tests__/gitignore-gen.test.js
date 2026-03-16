const { generateGitignore, getMissingEntries } = require('../gitignore-gen');

describe('generateGitignore', () => {
  test('generates Node.js gitignore', () => {
    const content = generateGitignore('nodejs');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain('dist/');
  });

  test('generates Python gitignore', () => {
    const content = generateGitignore('python');
    expect(content).toContain('__pycache__/');
    expect(content).toContain('.env');
    expect(content).toContain('venv/');
  });

  test('generates fastapi-nextjs gitignore', () => {
    const content = generateGitignore('fastapi-nextjs');
    expect(content).toContain('node_modules/');
    expect(content).toContain('__pycache__/');
    expect(content).toContain('.next/');
    expect(content).toContain('.env');
  });

  test('generates Go gitignore', () => {
    const content = generateGitignore('go');
    expect(content).toContain('/bin/');
    expect(content).toContain('.env');
  });

  test('generates Rust gitignore', () => {
    const content = generateGitignore('rust');
    expect(content).toContain('/target/');
  });

  test('falls back to default for unknown stack', () => {
    const content = generateGitignore('unknown-stack');
    expect(content).toContain('.env');
    expect(content).toContain('.DS_Store');
  });

  test('default gitignore includes .env', () => {
    const content = generateGitignore('default');
    expect(content).toContain('.env');
  });
});

describe('getMissingEntries', () => {
  test('returns all critical entries when gitignore is empty', () => {
    const missing = getMissingEntries('', 'nodejs');
    expect(missing).toContain('node_modules/');
    expect(missing).toContain('.env');
  });

  test('returns nothing when all entries present', () => {
    const existing = 'node_modules/\n.env\n';
    const missing = getMissingEntries(existing, 'nodejs');
    expect(missing).toHaveLength(0);
  });

  test('detects missing .env when node_modules is present', () => {
    const existing = 'node_modules/\n';
    const missing = getMissingEntries(existing, 'nodejs');
    expect(missing).toEqual(['.env']);
  });

  test('handles entries with leading slash variant', () => {
    const existing = '/node_modules/\n.env\n';
    const missing = getMissingEntries(existing, 'nodejs');
    expect(missing).toHaveLength(0);
  });

  test('returns critical entries for Python', () => {
    const missing = getMissingEntries('', 'python');
    expect(missing).toContain('__pycache__/');
    expect(missing).toContain('.env');
    expect(missing).toContain('venv/');
  });

  test('returns .env for unknown stack', () => {
    const missing = getMissingEntries('', 'whatever');
    expect(missing).toContain('.env');
  });
});
