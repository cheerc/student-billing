import nextConfig from "eslint-config-next";
import { globalIgnores } from 'eslint/config';

const eslintConfig = [
  ...nextConfig,
  globalIgnores(['full-e2e/**', 'blob-report/full-e2e/**', 'test-results/full-e2e/**']),
];

export default eslintConfig;
