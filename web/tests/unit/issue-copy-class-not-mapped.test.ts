import { describe, it, expect } from 'vitest';
import { issueMessage } from '@/lib/issue-copy';

describe('#201：CLASS_NOT_MAPPED 的正式 issue-copy 保留班名同步引導', () => {
  it('issueMessage 以代碼解析出的說明含「班名同步」', () => {
    expect(issueMessage({ code: 'CLASS_NOT_MAPPED' })).toContain('班名同步');
  });
});
