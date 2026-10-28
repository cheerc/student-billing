import type { ClassType } from '@/contracts/settings';
import type { CategorySource, ClassCategory, WritableCategorySource } from './class-category';

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
