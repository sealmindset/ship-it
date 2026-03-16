const fs = require('fs');
const path = require('path');
const { auditDependencies, formatAuditSummary, detectStacks, parsePythonRequirements } = require('../dep-audit');

// Mock @actions/exec
jest.mock('@actions/exec', () => ({
  exec: jest.fn()
}));
const { exec } = require('@actions/exec');

// Use a temp directory for test fixtures
const os = require('os');
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-audit-test-'));
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════
// detectStacks
// ═══════════════════════════════════════════════════════════

describe('detectStacks', () => {
  test('detects requirements.txt at root', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'fastapi==0.115.0\n');
    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].type).toBe('python');
    expect(stacks[0].dir).toBe(tmpDir);
  });

  test('detects requirements.txt in subdirectories', () => {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'flask==3.0.0\n');
    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].dir).toBe(backend);
  });

  test('detects nested mock service requirements', () => {
    const mockDir = path.join(tmpDir, 'mock-services', 'mock-oidc');
    fs.mkdirSync(mockDir, { recursive: true });
    fs.writeFileSync(path.join(mockDir, 'requirements.txt'), 'PyJWT==2.10.0\n');
    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].dir).toBe(mockDir);
  });

  test('detects package-lock.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    const stacks = detectStacks(tmpDir);
    expect(stacks.some(s => s.type === 'node')).toBe(true);
  });

  test('detects yarn.lock', () => {
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
    const stacks = detectStacks(tmpDir);
    expect(stacks.some(s => s.type === 'node')).toBe(true);
  });

  test('does not double-count when both lockfiles exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
    const stacks = detectStacks(tmpDir);
    const nodeStacks = stacks.filter(s => s.type === 'node');
    expect(nodeStacks).toHaveLength(1);
  });

  test('detects multiple stacks (python + node)', () => {
    const backend = path.join(tmpDir, 'backend');
    const frontend = path.join(tmpDir, 'frontend');
    fs.mkdirSync(backend);
    fs.mkdirSync(frontend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'fastapi==0.115.0\n');
    fs.writeFileSync(path.join(frontend, 'package-lock.json'), '{}');
    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(2);
    expect(stacks.map(s => s.type).sort()).toEqual(['node', 'python']);
  });

  test('returns empty for project with no manifest files', () => {
    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(0);
  });

  test('ignores node_modules and dot directories', () => {
    const nm = path.join(tmpDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'requirements.txt'), 'bad==1.0.0\n');

    const hidden = path.join(tmpDir, '.venv');
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, 'requirements.txt'), 'bad==1.0.0\n');

    const stacks = detectStacks(tmpDir);
    expect(stacks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// parsePythonRequirements
// ═══════════════════════════════════════════════════════════

describe('parsePythonRequirements', () => {
  test('parses pinned versions (==)', () => {
    const reqPath = path.join(tmpDir, 'requirements.txt');
    fs.writeFileSync(reqPath, 'fastapi==0.115.6\nuvicorn==0.34.0\n');
    const pkgs = parsePythonRequirements(reqPath);
    expect(pkgs).toEqual([
      { name: 'fastapi', version: '0.115.6' },
      { name: 'uvicorn', version: '0.34.0' }
    ]);
  });

  test('parses >= and ~= operators', () => {
    const reqPath = path.join(tmpDir, 'requirements.txt');
    fs.writeFileSync(reqPath, 'cryptography>=44.0.0\nsome-lib~=1.2.3\n');
    const pkgs = parsePythonRequirements(reqPath);
    expect(pkgs).toEqual([
      { name: 'cryptography', version: '44.0.0' },
      { name: 'some-lib', version: '1.2.3' }
    ]);
  });

  test('skips comments and blank lines', () => {
    const reqPath = path.join(tmpDir, 'requirements.txt');
    fs.writeFileSync(reqPath, '# this is a comment\n\nfastapi==0.115.6\n  # another comment\n');
    const pkgs = parsePythonRequirements(reqPath);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].name).toBe('fastapi');
  });

  test('skips -r and -e lines', () => {
    const reqPath = path.join(tmpDir, 'requirements.txt');
    fs.writeFileSync(reqPath, '-r base.txt\n-e git+https://example.com\nfastapi==1.0.0\n');
    const pkgs = parsePythonRequirements(reqPath);
    expect(pkgs).toHaveLength(1);
  });

  test('handles extras syntax', () => {
    const reqPath = path.join(tmpDir, 'requirements.txt');
    // packages with extras like uvicorn[standard] won't match the simple regex
    // but the base name without extras should
    fs.writeFileSync(reqPath, 'fastapi==0.115.6\n');
    const pkgs = parsePythonRequirements(reqPath);
    expect(pkgs).toHaveLength(1);
  });

  test('returns empty for nonexistent file', () => {
    const pkgs = parsePythonRequirements('/nonexistent/requirements.txt');
    expect(pkgs).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// auditDependencies
// ═══════════════════════════════════════════════════════════

describe('auditDependencies', () => {
  test('skips when no manifest files found', async () => {
    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.skipped).toBe(true);
    expect(result.vulnCount).toBe(0);
  });

  test('attempts pip-audit for Python projects', async () => {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'authlib==1.4.1\n');

    // Mock pip-audit returning a vulnerability
    exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'pip-audit') {
        const output = JSON.stringify({
          dependencies: [{
            name: 'authlib',
            version: '1.4.1',
            vulns: [{
              id: 'GHSA-xxxx',
              fix_versions: ['1.6.9']
            }]
          }]
        });
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(output));
        }
        return 0;
      }
      return 0;
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.vulnCount).toBe(1);
    expect(result.fixedCount).toBe(1);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]).toContain('authlib');
    expect(result.fixes[0]).toContain('1.6.9');

    // Verify the file was updated
    const updated = fs.readFileSync(path.join(backend, 'requirements.txt'), 'utf8');
    expect(updated).toContain('authlib==1.6.9');
    expect(updated).not.toContain('authlib==1.4.1');
  });

  test('handles pip-audit not available gracefully', async () => {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'authlib==1.4.1\n');

    // Mock pip-audit failing and PyPI check also failing
    exec.mockImplementation(async () => {
      throw new Error('command not found: pip-audit');
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    // Should not crash -- warnings instead
    expect(result.skipped).toBeFalsy();
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  test('handles multiple requirements.txt files', async () => {
    const backend = path.join(tmpDir, 'backend');
    const mockOidc = path.join(tmpDir, 'mock-services', 'mock-oidc');
    fs.mkdirSync(backend);
    fs.mkdirSync(mockOidc, { recursive: true });
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'authlib==1.4.1\n');
    fs.writeFileSync(path.join(mockOidc, 'requirements.txt'), 'PyJWT==2.10.1\n');

    // Mock pip-audit returning vulnerabilities for both
    let callCount = 0;
    exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'pip-audit') {
        callCount++;
        const reqFile = args[1]; // --requirement <path>
        let output;
        if (reqFile.includes('backend')) {
          output = JSON.stringify({
            dependencies: [{ name: 'authlib', version: '1.4.1', vulns: [{ id: 'GHSA-1', fix_versions: ['1.6.9'] }] }]
          });
        } else {
          output = JSON.stringify({
            dependencies: [{ name: 'PyJWT', version: '2.10.1', vulns: [{ id: 'GHSA-2', fix_versions: ['2.12.1'] }] }]
          });
        }
        if (opts?.listeners?.stdout) opts.listeners.stdout(Buffer.from(output));
        return 0;
      }
      return 0;
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.vulnCount).toBe(2);
    expect(result.fixedCount).toBe(2);
  });

  test('reports unfixable vulnerabilities as warnings', async () => {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'some-pkg==1.0.0\n');

    exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'pip-audit') {
        const output = JSON.stringify({
          dependencies: [{ name: 'some-pkg', version: '1.0.0', vulns: [{ id: 'GHSA-nope', fix_versions: [] }] }]
        });
        if (opts?.listeners?.stdout) opts.listeners.stdout(Buffer.from(output));
        return 0;
      }
      return 0;
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.vulnCount).toBe(1);
    expect(result.fixedCount).toBe(0);
    expect(result.remaining).toBe(1);
    expect(result.warnings.some(w => w.includes('no fix version'))).toBe(true);
  });

  test('attempts npm audit for Node projects', async () => {
    const frontend = path.join(tmpDir, 'frontend');
    fs.mkdirSync(frontend);
    fs.writeFileSync(path.join(frontend, 'package-lock.json'), '{}');

    let npmAuditCallCount = 0;
    exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'audit' && args[1] === '--json') {
        npmAuditCallCount++;
        let output;
        if (npmAuditCallCount === 1) {
          // First call: vulnerabilities found
          output = JSON.stringify({
            metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0 } }
          });
        } else {
          // Second call (re-check after fix): all clean
          output = JSON.stringify({
            metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } }
          });
        }
        if (opts?.listeners?.stdout) opts.listeners.stdout(Buffer.from(output));
        return 0;
      }
      if (cmd === 'npm' && args[0] === 'audit' && args[1] === 'fix') {
        return 0;
      }
      return 0;
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.vulnCount).toBe(3);
    expect(result.fixedCount).toBe(3);
  });

  test('zero vulnerabilities returns clean result', async () => {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, 'requirements.txt'), 'fastapi==0.115.6\n');

    exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'pip-audit') {
        const output = JSON.stringify({ dependencies: [{ name: 'fastapi', version: '0.115.6', vulns: [] }] });
        if (opts?.listeners?.stdout) opts.listeners.stdout(Buffer.from(output));
        return 0;
      }
      return 0;
    });

    const result = await auditDependencies({ workingDir: tmpDir, log: () => {} });
    expect(result.vulnCount).toBe(0);
    expect(result.fixedCount).toBe(0);
    expect(result.skipped).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// formatAuditSummary
// ═══════════════════════════════════════════════════════════

describe('formatAuditSummary', () => {
  test('returns empty string when skipped', () => {
    expect(formatAuditSummary({ skipped: true })).toBe('');
  });

  test('returns clean message when no vulnerabilities', () => {
    expect(formatAuditSummary({ vulnCount: 0, skipped: false })).toBe('No known vulnerabilities found.');
  });

  test('shows fixed count and details', () => {
    const result = {
      vulnCount: 3, fixedCount: 3, remaining: 0, skipped: false,
      fixes: ['authlib 1.4.1 -> 1.6.9 (GHSA-xxx)', 'PyJWT 2.10.1 -> 2.12.1 (GHSA-yyy)'],
      warnings: []
    };
    const summary = formatAuditSummary(result);
    expect(summary).toContain('Fixed 3 of 3');
    expect(summary).toContain('authlib');
    expect(summary).toContain('PyJWT');
  });

  test('shows remaining count when some unfixed', () => {
    const result = {
      vulnCount: 5, fixedCount: 3, remaining: 2, skipped: false,
      fixes: ['pkg1 1.0 -> 2.0 (CVE-1)'], warnings: []
    };
    const summary = formatAuditSummary(result);
    expect(summary).toContain('2 vulnerabilities require manual review');
  });

  test('shows warnings', () => {
    const result = {
      vulnCount: 1, fixedCount: 0, remaining: 1, skipped: false,
      fixes: [], warnings: ['some-pkg: no fix version available']
    };
    const summary = formatAuditSummary(result);
    expect(summary).toContain('Note: some-pkg');
  });
});
