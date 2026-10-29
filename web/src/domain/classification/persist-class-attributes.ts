import type { ClassType } from '@/contracts/settings';
import type { CategorySource, ClassCategory, WritableCategorySource } from './class-category';
import type { ClassAttributesView } from './class-attributes';

/** Read-side attributes accepted by the draft writer, including legacy values that must be dropped. */
export interface ClassAttributesForDraft {
  classType?: ClassType;
  hasMultiSubjectDiscount?: boolean;
  category?: ClassCategory;
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
}

/** The only category sources new settings drafts may contain. */
export interface PersistedClassAttributes {
  classType?: ClassType;
  hasMultiSubjectDiscount?: boolean;
  category?: ClassCategory;
  categorySource?: WritableCategorySource;
  fixedFiveDays?: boolean;
}

/**
 * Convert effective/read-side class attributes into fields safe to write to SettingsDraft.
 *
 * - manual keeps the explicit user choice;
 * - unset always writes the explicit unset marker, so a later seed fallback cannot restore it;
 * - seed and legacy auto are read compatibility only and are omitted;
 * - fixedFiveDays and hasMultiSubjectDiscount remain explicit booleans when provided.
 */
export function persistClassAttributes(attributes: ClassAttributesForDraft): PersistedClassAttributes {
  const categoryFields: Pick<PersistedClassAttributes, 'category' | 'categorySource'> =
    attributes.categorySource === 'unset' ||
    (attributes.categorySource === 'manual' && attributes.category === 'unset')
      ? { category: 'unset', categorySource: 'unset' }
      : attributes.categorySource === 'manual' && attributes.category !== undefined
        ? { category: attributes.category, categorySource: 'manual' }
        : {};

  return {
    ...(attributes.classType !== undefined ? { classType: attributes.classType } : {}),
    ...(attributes.hasMultiSubjectDiscount !== undefined
      ? { hasMultiSubjectDiscount: attributes.hasMultiSubjectDiscount }
      : {}),
    ...categoryFields,
    ...(attributes.fixedFiveDays !== undefined ? { fixedFiveDays: attributes.fixedFiveDays } : {}),
  };
}

/**
 * 把手動覆寫寫進 draft 的班級（存檔／預覽都用它）。
 * specs/14 §3.10：classType 與 fixedFiveDays 隨班保存，不再有 fixedSource。
 */
export function applyManualAttrsToClasses<T extends { baseName: string; classType?: ClassType | 'non_care'; fixedFiveDays?: boolean }>(
  classes: T[],
  manualAttrs: Map<string, ClassAttributesView>
): T[] {
  return classes.map((c) => {
    const clean = { ...c };
    delete (clean as Record<string, unknown>).category;
    delete (clean as Record<string, unknown>).categorySource;
    delete (clean as Record<string, unknown>).fixedFiveDays;
    const m = manualAttrs.get(c.baseName);
    const resolvedClassType = (m?.classType ?? c.classType) as ClassType;
    return {
      ...clean,
      classType: resolvedClassType,
      ...persistClassAttributes({
        classType: resolvedClassType,
        hasMultiSubjectDiscount: m?.hasMultiSubjectDiscount,
        category: m?.category,
        categorySource: m?.categorySource,
        fixedFiveDays: resolvedClassType === 'care' ? (m?.fixedFiveDays ?? c.fixedFiveDays ?? false) : false,
      }),
    };
  });
}
