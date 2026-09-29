/**
 * 日期時間顯示（純函式，可在 server 與 client component 共用）。
 *
 * 固定使用 Asia/Taipei：server 與瀏覽器格式一致，避免 hydration 不一致，
 * 也讓「來源日期」在不同機器上看起來相同（09 §2 來源時間要清楚）。
 * 只顯示到分鐘，不混稱月帳期。
 */
const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO 時間 → 'YYYY-MM-DD HH:mm'（Asia/Taipei）；無法解析時原樣回傳。 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(FORMATTER.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
