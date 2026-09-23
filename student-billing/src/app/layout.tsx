import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: '學生收費核對工具 (student-billing)',
  description: 'localhost P1 原型工具 - 學生收費核對與名單篩選',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body>
        <div className="container">
          <header className="header">
            <div className="header-title">
              <span className="logo-badge">P1</span>
              <h1>學生收費核對工具</h1>
            </div>
            <nav className="nav">
              <Link href="/" className="nav-link">首頁核對</Link>
              <Link href="/imports" className="nav-link">名單匯入</Link>
            </nav>
          </header>
          <main className="main">{children}</main>
          <footer className="footer">
            <p>學生收費核對工具 · localhost 原型模式 · 嚴格隔離敏感個資</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
