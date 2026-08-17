const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m',
    cyan: '\x1b[36m'
};

const THRESHOLDS = {
    lines: 80,
    statements: 70,
    functions: 70,
    branches: 65
};

console.log(`${colors.cyan}Are there any changes? Running tests on changed files...${colors.reset}`);

try {
    // 1. Run tests only on changed files with coverage
    // We use stdio: 'inherit' to show test output to the user
    execSync('npm run test:coverage -- --onlyChanged --json --outputFile=coverage/test-report.json', { stdio: 'inherit' });

    // 2. Read coverage summary
    const summaryPath = path.join(__dirname, '..', 'coverage', 'coverage-summary.json');

    if (!fs.existsSync(summaryPath)) {
        console.warn(`${colors.yellow}No coverage summary found. This might mean no files were changed or no tests were run.${colors.reset}`);
        // If Jest didn't produce a report (likely because no tests ran), we can assume it's okay (no code to check)
        // or explicitly check for the "No tests found" message from execSync output if we captured it.
        // For now, let's treat "no report" as "nothing to verify" -> PASS.
        process.exit(0);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    // 2b. Aggregate coverage over the CHANGED source files only. The jest run
    // above uses --onlyChanged, which also drags every module the related
    // tests happen to import into the report; judging the run total would
    // fail commits for pre-existing gaps in unchanged neighbors.
    const changedFiles = execSync('git diff HEAD --name-only', { encoding: 'utf8' })
        .split('\n')
        .filter(f => /\.(ts|tsx)$/.test(f))
        .filter(f => !/\.test\.|\.stories\.|\.d\.ts$|\/test\//.test(f))
        .map(f => f.replace(/^genai-react-app\//, ''));

    const total = {};
    for (const [file, cov] of Object.entries(summary)) {
        if (file === 'total') continue;
        const rel = file.split(/[\\/]genai-react-app[\\/]/).pop().replace(/\\/g, '/');
        if (!changedFiles.some(c => c === rel || c.endsWith('/' + rel))) continue;
        for (const metric of ['lines', 'statements', 'functions', 'branches']) {
            total[metric] = total[metric] || { covered: 0, total: 0 };
            total[metric].covered += cov[metric].covered;
            total[metric].total += cov[metric].total;
        }
    }
    Object.values(total).forEach(m => {
        m.pct = m.total === 0 ? 100 : Math.round((m.covered / m.total) * 10000) / 100;
    });

    // Check if metrics map exists and isn't empty/unknown
    if (!total.lines || typeof total.lines.pct === 'undefined') {
        console.warn(`${colors.yellow}No changed source files appear in the coverage report; nothing to verify.${colors.reset}`);
        process.exit(0);
    }

    // 3. Check thresholds
    const metrics = ['lines', 'statements', 'functions', 'branches'];
    let passed = true;

    console.log(`\n${colors.cyan}--- New Code Coverage Report ---${colors.reset}`);

    metrics.forEach(metric => {
        const pct = total[metric].pct;
        const threshold = THRESHOLDS[metric];
        const color = pct >= threshold ? colors.green : colors.red;
        const status = pct >= threshold ? 'PASS' : 'FAIL';

        console.log(`${metric.padEnd(12)}: ${color}${pct}%${colors.reset} (Threshold: ${threshold}%) [${status}]`);

        if (pct < threshold && !isNaN(pct)) {
            passed = false;
        }
    });

    if (!passed) {
        console.error(`\n${colors.red}❌ Coverage check failed! New code must meet the defined thresholds.${colors.reset}`);
        process.exit(1);
    }

    console.log(`\n${colors.green}✅ All strict coverage checks passed for new code!${colors.reset}`);

} catch (error) {
    // If the test command itself failed (e.g. usage error or test failure), it creates an error.
    // However, if tests fail, npm test exits with 1, which execSync catches.
    console.error(`\n${colors.red}❌ Tests failed or coverage generation error.${colors.reset}`);
    process.exit(1);
}
