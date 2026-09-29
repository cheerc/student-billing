import { getDatabase } from '@/adapters/sqlite';
import { buildHistoryEntries } from '@/application/history-view';
import { HistoryList } from '@/components/history/history-list';

export const dynamic = 'force-dynamic';

/**
 * 匯入紀錄（次入口，specs/09 §2）：日期／檔名查過去資料，唯讀。
 * 資料整理在 application/history-view（只讀 DB），畫面在 HistoryList。
 */
export default async function HistoryPage() {
  const db = getDatabase();
  return <HistoryList entries={buildHistoryEntries(db)} />;
}
