const { exec } = require('@actions/exec');
const fs = require('fs');
const path = require('path');

/**
 * Pre-push dependency audit.
 *
 * Scans Python (pip-audit) and Node.js (npm audit) dependencies for known
 * vulnerabilities. When fixable, upgrades the affected packages in-place
 * and returns a summary. Non-blocking: if the audit tool itself is missing
 * or a fix can't be applied, the ship flow continues with a warning.
 *
 * Returns:
 *   { vulnCount, fixedCount, remaining, fixes[], warnings[], skipped }
 */
async function auditDependencies({ workingDir, log }) {
  log = log || console.log;
  const result = {
    vulnCount: 0,
    fixedCount: 0,
    remaining: 0,
    fixes: [],
    warnings: [],
    skipped: false
  };

  const detectedStacks = detectStacks(workingDir);

  if (detectedStacks.length === 0) {
    result.skipped = true;
    result.warnings.push('No requirements.txt or package-lock.json found -- skipping audit.');
    return result;
  }

  for (const stack of detectedStacks) {
    if (stack.type === 'python') {
      await auditPython(stack, result, log);
    } else if (stack.type === 'node') {
      await auditNode(stack, result, log);
    }
  }

  result.remaining = result.vulnCount - result.fixedCount;
  return result;
}

// ═══════════════════════════════════════════════════════════
// STACK DETECTION
// ═══════════════════════════════════════════════════════════

function detectStacks(workingDir) {
  const stacks = [];

  // Find all requirements.txt files (backend, mock services, etc.)
  const pythonDirs = findFilesUp(workingDir, 'requirements.txt');
  for (const dir of pythonDirs) {
    stacks.push({ type: 'python', dir, manifest: path.join(dir, 'requirements.txt') });
  }

  // Find package-lock.json or yarn.lock (frontend, root, etc.)
  const nodeDirs = findFilesUp(workingDir, 'package-lock.json');
  for (const dir of nodeDirs) {
    stacks.push({ type: 'node', dir, manifest: path.join(dir, 'package-lock.json'), tool: 'npm' });
  }

  // yarn.lock gets npm audit too (via npx)
  const yarnDirs = findFilesUp(workingDir, 'yarn.lock');
  for (const dir of yarnDirs) {
    // Don't double-count if package-lock.json also exists
    if (!nodeDirs.includes(dir)) {
      stacks.push({ type: 'node', dir, manifest: path.join(dir, 'yarn.lock'), tool: 'yarn' });
    }
  }

  return stacks;
}

/**
 * Find directories containing `filename` at workingDir and one level of subdirectories.
 */
function findFilesUp(workingDir, filename) {
  const dirs = [];

  // Check root
  if (fs.existsSync(path.join(workingDir, filename))) {
    dirs.push(workingDir);
  }

  // Check immediate subdirectories (backend/, frontend/, mock-services/*/,  etc.)
  try {
    const entries = fs.readdirSync(workingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const subdir = path.join(workingDir, entry.name);
      if (fs.existsSync(path.join(subdir, filename))) {
        dirs.push(subdir);
      }

      // One more level (mock-services/mock-oidc/, etc.)
      try {
        const subEntries = fs.readdirSync(subdir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const nested = path.join(subdir, sub.name);
          if (fs.existsSync(path.join(nested, filename))) {
            dirs.push(nested);
          }
        }
      } catch { /* ignore unreadable dirs */ }
    }
  } catch { /* ignore */ }

  return dirs;
}

// ═══════════════════════════════════════════════════════════
// PYTHON AUDIT
// ═══════════════════════════════════════════════════════════

async function auditPython(stack, result, log) {
  const reqPath = stack.manifest;
  const label = path.relative(path.dirname(path.dirname(reqPath)) || '.', reqPath) || 'requirements.txt';

  // Parse current requirements
  const packages = parsePythonRequirements(reqPath);
  if (packages.length === 0) return;

  // Try pip-audit first (structured output)
  let vulnerabilities = [];
  try {
    vulnerabilities = await runPipAudit(reqPath);
  } catch {
    // pip-audit not available -- fall back to PyPI advisory check
    try {
      vulnerabilities = await checkPyPIAdvisories(packages);
    } catch {
      result.warnings.push(`Could not audit ${label} -- pip-audit not available and PyPI check failed.`);
      return;
    }
  }

  if (vulnerabilities.length === 0) return;

  result.vulnCount += vulnerabilities.length;
  log(`  Found ${vulnerabilities.length} vulnerabilities in ${label}`);

  // Attempt to fix: upgrade each vulnerable package to its fix version
  const reqContent = fs.readFileSync(reqPath, 'utf8');
  let updatedContent = reqContent;
  const fixed = [];

  for (const vuln of vulnerabilities) {
    const { name, installedVersion, fixVersion } = vuln;
    if (!fixVersion) {
      result.warnings.push(`${name}: no fix version available (${vuln.advisory})`);
      continue;
    }

    // Replace pinned version in requirements.txt
    const patterns = [
      new RegExp(`^${escapeRegex(name)}\\s*==\\s*${escapeRegex(installedVersion)}`, 'mi'),
      new RegExp(`^${escapeRegex(name)}\\s*>=\\s*[\\d.]+`, 'mi'),
      new RegExp(`^${escapeRegex(name)}\\s*~=\\s*[\\d.]+`, 'mi'),
    ];

    let replaced = false;
    for (const pattern of patterns) {
      if (pattern.test(updatedContent)) {
        updatedContent = updatedContent.replace(pattern, `${name}==${fixVersion}`);
        replaced = true;
        break;
      }
    }

    if (replaced) {
      fixed.push({ name, from: installedVersion, to: fixVersion, advisory: vuln.advisory });
      log(`    Fixed: ${name} ${installedVersion} -> ${fixVersion}`);
    } else {
      result.warnings.push(`${name}: could not locate version pin in ${label}`);
    }
  }

  if (fixed.length > 0) {
    fs.writeFileSync(reqPath, updatedContent);
    result.fixedCount += fixed.length;
    result.fixes.push(...fixed.map(f => `${f.name} ${f.from} -> ${f.to} (${f.advisory})`));
  }
}

/**
 * Parse requirements.txt into [{name, version}].
 */
function parsePythonRequirements(reqPath) {
  try {
    const content = fs.readFileSync(reqPath, 'utf8');
    const packages = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:==|>=|~=)\s*([^\s;#]+)/);
      if (match) {
        packages.push({ name: match[1], version: match[2] });
      }
    }
    return packages;
  } catch {
    return [];
  }
}

/**
 * Run pip-audit on a requirements file and return structured vulnerabilities.
 */
async function runPipAudit(reqPath) {
  let output = '';
  try {
    await exec('pip-audit', ['--requirement', reqPath, '--format', 'json', '--output', '-'], {
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => { output += data.toString(); }
      }
    });
  } catch {
    throw new Error('pip-audit not available');
  }

  try {
    const data = JSON.parse(output);
    const vulns = [];
    for (const dep of (data.dependencies || [])) {
      for (const vuln of (dep.vulns || [])) {
        vulns.push({
          name: dep.name,
          installedVersion: dep.version,
          fixVersion: vuln.fix_versions?.[0] || null,
          advisory: vuln.id || vuln.aliases?.[0] || 'unknown'
        });
      }
    }
    return vulns;
  } catch {
    throw new Error('pip-audit output not parseable');
  }
}

/**
 * Fallback: check PyPI JSON API for known vulnerabilities.
 * Uses the /json endpoint which includes vulnerability info since PEP 685.
 */
async function checkPyPIAdvisories(packages) {
  const https = require('https');
  const vulns = [];

  for (const pkg of packages) {
    try {
      const data = await fetchJSON(`https://pypi.org/pypi/${pkg.name}/${pkg.version}/json`);
      const advisories = data?.vulnerabilities || [];
      for (const adv of advisories) {
        const fixVersion = findFixVersion(adv, pkg.version);
        vulns.push({
          name: pkg.name,
          installedVersion: pkg.version,
          fixVersion,
          advisory: adv.id || adv.aliases?.[0] || 'unknown'
        });
      }
    } catch {
      // Skip packages we can't check
    }
  }

  return vulns;
}

/**
 * Find the lowest fix version from advisory data.
 */
function findFixVersion(advisory, currentVersion) {
  const fixed = advisory.fixed_in || [];
  if (fixed.length === 0) return null;
  // Return the first (lowest) fix version
  return fixed.sort(compareVersions)[0] || null;
}

// ═══════════════════════════════════════════════════════════
// NODE AUDIT
// ═══════════════════════════════════════════════════════════

async function auditNode(stack, result, log) {
  const label = path.relative(path.dirname(path.dirname(stack.dir)) || '.', stack.dir) || '.';

  // npm audit --json
  let output = '';
  try {
    await exec('npm', ['audit', '--json'], {
      cwd: stack.dir,
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => { output += data.toString(); }
      }
    });
  } catch {
    result.warnings.push(`Could not run npm audit in ${label}`);
    return;
  }

  let auditData;
  try {
    auditData = JSON.parse(output);
  } catch {
    result.warnings.push(`npm audit output not parseable in ${label}`);
    return;
  }

  const totalVulns = auditData.metadata?.vulnerabilities || {};
  const vulnCount = (totalVulns.critical || 0) + (totalVulns.high || 0) +
                    (totalVulns.moderate || 0) + (totalVulns.low || 0);

  if (vulnCount === 0) return;

  result.vulnCount += vulnCount;
  log(`  Found ${vulnCount} vulnerabilities in ${label}`);

  // Try npm audit fix
  let fixOutput = '';
  try {
    await exec('npm', ['audit', 'fix'], {
      cwd: stack.dir,
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => { fixOutput += data.toString(); }
      }
    });
  } catch {
    result.warnings.push(`npm audit fix failed in ${label}`);
    return;
  }

  // Re-check to see what was fixed
  let recheck = '';
  try {
    await exec('npm', ['audit', '--json'], {
      cwd: stack.dir,
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => { recheck += data.toString(); }
      }
    });
    const recheckData = JSON.parse(recheck);
    const remaining = recheckData.metadata?.vulnerabilities || {};
    const remainingCount = (remaining.critical || 0) + (remaining.high || 0) +
                           (remaining.moderate || 0) + (remaining.low || 0);
    const fixedCount = vulnCount - remainingCount;

    if (fixedCount > 0) {
      result.fixedCount += fixedCount;
      result.fixes.push(`npm: ${fixedCount} vulnerabilities fixed in ${label}`);
      log(`    Fixed: ${fixedCount} of ${vulnCount}`);
    }
    if (remainingCount > 0) {
      result.warnings.push(`${remainingCount} npm vulnerabilities remain in ${label} (require manual review)`);
    }
  } catch {
    // Can't verify -- assume some were fixed
    result.fixes.push(`npm audit fix ran in ${label}`);
  }
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function fetchJSON(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/**
 * Format the audit result into a human-readable summary for the PR description.
 */
function formatAuditSummary(result) {
  if (result.skipped) return '';
  if (result.vulnCount === 0) return 'No known vulnerabilities found.';

  const lines = [];
  if (result.fixedCount > 0) {
    lines.push(`Fixed ${result.fixedCount} of ${result.vulnCount} known vulnerabilities before push:`);
    for (const fix of result.fixes) {
      lines.push(`  - ${fix}`);
    }
  }
  if (result.remaining > 0) {
    lines.push(`${result.remaining} vulnerabilities require manual review.`);
  }
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      lines.push(`Note: ${w}`);
    }
  }
  return lines.join('\n');
}

module.exports = { auditDependencies, formatAuditSummary, detectStacks, parsePythonRequirements };
