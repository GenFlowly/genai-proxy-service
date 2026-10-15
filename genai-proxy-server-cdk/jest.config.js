// Stack assertion tests (aws-cdk-lib/assertions). Building a stack needs
// @genflowly/cdk-commons from the private GitHub registry, so run them where
// `npm ci` can authenticate (CI writes the .npmrc first).

// cdk-commons still sets the deprecated pointInTimeRecovery table prop; keep
// jsii's per-table deprecation warning out of the test output.
process.env.JSII_DEPRECATED = process.env.JSII_DEPRECATED || 'quiet';

module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
    },
};
