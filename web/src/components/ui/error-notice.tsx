import React from 'react';
import type { UserFacingError } from '@/lib/user-messages';

interface ErrorNoticeProps extends Partial<UserFacingError> {
  /** 主文前的標題（選用） */
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** 供測試與樣式定位的標記，例如 data-dialog-error */
  [key: `data-${string}`]: string | undefined;
}

/**
 * 錯誤說明區塊（D39）：白話主文＋可展開的「詳細資訊」（預設收合）。
 * 錯誤代碼與伺服器原始訊息只在詳細資訊裡，主畫面不外露工程用語。
 */
export function ErrorNotice({ message, detail, title, className, style, ...rest }: ErrorNoticeProps) {
  const dataProps = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('data-')));
  return (
    <div className={`alert alert-danger error-notice${className ? ` ${className}` : ''}`} role="alert" style={style} {...dataProps}>
      {title && <div className="error-notice-title">{title}</div>}
      <div className="error-notice-message">{message}</div>
      {detail ? (
        <details className="error-details">
          <summary>詳細資訊</summary>
          <pre className="tech-pre">{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
export default ErrorNotice;
