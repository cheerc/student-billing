// T1 驗收工具的 stub：只印一行 marker 然後停住，永不印 SESSION／READY，也永不 ready。
//
// 用途是讓 acceptance-env.test.ts 的 timeout 測試能真的走 start() 的 deadline 路徑，
// 卻不必真的跑 `git archive` → `npm ci` → `next build`（那是 28–48 秒的重量級行程）。
// 因為它不碰 mkdtemp、不開 server、不佔 3840 埠，測試不會在 tmp 或網路上留殘留，
// afterEach 只需沿用既有的 SIGTERM 清理。
//
// 它「存活但沒有進度」正是我們要模擬的情境：真實 T1 卡住時也不會多說一句話。
console.log('STUB-T1-READY-NEVER');
setInterval(() => {}, 1000);