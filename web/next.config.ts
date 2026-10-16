import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'exceljs'],
  typescript: {
    // T1 驗收環境（scripts/acceptance-env.ts）只需要能起 production server，不驗證型別；
    // 在該路徑跳過型別檢查，以免整段 tsc 佔滿 T1 的 120s 預算。
    //
    // 條件式而非無條件，是刻意的：產品 build（npm run build，含 ci.yml 步驟 5）不設
    // ACCEPTANCE_ENV，仍照常型別檢查。
    //
    // 充分條件不依賴「CI 沒設這個變數」，而是 ci.yml 的步驟順序：步驟 2 的
    // `npm run typecheck`（tsc --noEmit）早於步驟 5 的 `npm run build`，且 tsconfig 的
    // include（**/*.ts、.next/types、.next/dev/types）涵蓋 next build 編譯的同一批檔案
    // 且更寬（含 scripts/、tests/、next.config.ts），exclude 僅 node_modules。因此即使
    // build 跳過型別檢查，同一次 CI run 已在之前獨立跑過完整 tsc。
    // 已用注入真實型別錯誤對照驗證：產品 build 以 error TS2322 擋下、T1 build 通過。
    ignoreBuildErrors: process.env.ACCEPTANCE_ENV === '1',
  },
};

export default nextConfig;
