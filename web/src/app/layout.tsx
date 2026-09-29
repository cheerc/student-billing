import type { Metadata } from 'next';
import './globals.css';
import AppNav from '@/components/app-nav';

export const metadata: Metadata = {
  title: '學生收費核對工具',
  description: '學生收費核對與排課衝堂計算工具',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body>
        <div className="app-shell">
          <AppNav />
          <div className="main-wrapper">
            <main className="main" id="main-content">
              {children}
            </main>
            <footer className="footer">
              <p>學生收費核對工具 · 本機模式 · 嚴格隔離敏感個資</p>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
