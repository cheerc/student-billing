import { describe, it, expect } from 'vitest';
import { parseGrade } from '@/domain/students/grade-parser';

describe('U31: 年級解析單元測試', () => {
  it('應正確解析小一至小六之標準年級', () => {
    expect(parseGrade('一年級')).toEqual({ grade: 1, status: 'valid' });
    expect(parseGrade('二年級')).toEqual({ grade: 2, status: 'valid' });
    expect(parseGrade('三年級')).toEqual({ grade: 3, status: 'valid' });
    expect(parseGrade('四年級')).toEqual({ grade: 4, status: 'valid' });
    expect(parseGrade('五年級')).toEqual({ grade: 5, status: 'valid' });
    expect(parseGrade('六年級')).toEqual({ grade: 6, status: 'valid' });

    // 簡寫或數字
    expect(parseGrade('小一')).toEqual({ grade: 1, status: 'valid' });
    expect(parseGrade('小六')).toEqual({ grade: 6, status: 'valid' });
    expect(parseGrade('1')).toEqual({ grade: 1, status: 'valid' });
    expect(parseGrade('6')).toEqual({ grade: 6, status: 'valid' });
  });

  it('幼兒園與國中非國小收費年級，應判定為 not_applicable', () => {
    // 中班／小班／大班／幼兒園／國一
    expect(parseGrade('小班')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('中班')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('大班')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('幼兒園')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('幼幼班')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('國一')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('國二')).toEqual({ grade: null, status: 'not_applicable' });
    expect(parseGrade('國三')).toEqual({ grade: null, status: 'not_applicable' });
  });

  it('無、null、空字串或未識別文字，應判定為 unavailable', () => {
    expect(parseGrade('無')).toEqual({ grade: null, status: 'unavailable' });
    expect(parseGrade('')).toEqual({ grade: null, status: 'unavailable' });
    expect(parseGrade('   ')).toEqual({ grade: null, status: 'unavailable' });
    expect(parseGrade(null)).toEqual({ grade: null, status: 'unavailable' });
    expect(parseGrade(undefined)).toEqual({ grade: null, status: 'unavailable' });
    expect(parseGrade('未知年級XYZ')).toEqual({ grade: null, status: 'unavailable' });
  });
});
