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

const STRICT_THRESHOLD = 80;

console.log(`${colors.cyan}Are there any changes? Running tests on changed files...${colors.reset}`);

try {
    // 1. Run tests only on changed files with coverage
    // We use stdio: 'inherit' to show test output to the user
    execSync('npm run test:coverage -- --onlyChanged --json --outputFile=coverage/test-report.json', { stdio: 'inherit' });

    // 2. Read coverage summary
    const summaryPath = path.join(__dirname, '..', 'coverage', 'coverage-summary.json');

    if (!fs.existsSync(summaryPath)) {
        console.warn(`${colors.yellow}No coverage summary found. This might mean no files were changed or tested.${colors.reset}`);
        process.exit(0);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const total = summary.total;

    // 3. Check thresholds
    const metrics = ['lines', 'statements', 'functions', 'branches'];
    let passed = true;

    console.log(`\n${colors.cyan}--- New Code Coverage Report ---${colors.reset}`);

    metrics.forEach(metric => {
        const pct = total[metric].pct;
        const color = pct >= STRICT_THRESHOLD ? colors.green : colors.red;
        const status = pct >= STRICT_THRESHOLD ? 'PASS' : 'FAIL';

        console.log(`${metric.padEnd(12)}: ${color}${pct}%${colors.reset} (Threshold: ${STRICT_THRESHOLD}%) [${status}]`);

        if (pct < STRICT_THRESHOLD && !isNaN(pct)) {
            passed = false;
        }
    });

    if (!passed) {
        console.error(`\n${colors.red}❌ Coverage check failed! New code must meet the ${STRICT_THRESHOLD}% threshold.${colors.reset}`);
        process.exit(1);
    }

    console.log(`\n${colors.green}✅ All strict coverage checks passed for new code!${colors.reset}`);

} catch (error) {
    // If the test command itself failed (e.g. usage error or test failure), it creates an error.
    // However, if tests fail, npm test exits with 1, which execSync catches.
    console.error(`\n${colors.red}❌ Tests failed or coverage generation error.${colors.reset}`);
    process.exit(1);
}
