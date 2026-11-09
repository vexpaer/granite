export type HomeModuleId =
  | 'hero'
  | 'continue'
  | 'recent'
  | 'notes'
  | 'statistics'
  | 'goal'
  | 'tags';

export interface HomeModuleDefinition {
  id: HomeModuleId;
  label: string;
  description: string;
  countLabel?: string;
  minCount?: number;
  maxCount?: number;
  defaultCount?: number;
}

export const HOME_MODULES: readonly HomeModuleDefinition[] = [
  {
    id: 'hero',
    label: '欢迎区域',
    description: '日期、问候与全局导入入口。',
  },
  {
    id: 'continue',
    label: '继续阅读',
    description: '最近阅读中的一本书及真实进度。',
  },
  {
    id: 'recent',
    label: '最近阅读',
    description: '最近打开或更新的书籍。',
    countLabel: '书籍数量',
    minCount: 2,
    maxCount: 5,
    defaultCount: 5,
  },
  {
    id: 'notes',
    label: '最近笔记',
    description: '最近编辑的笔记与内容摘要。',
    countLabel: '笔记数量',
    minCount: 1,
    maxCount: 5,
    defaultCount: 3,
  },
  {
    id: 'statistics',
    label: '阅读统计',
    description: '当前周期的真实阅读时长与趋势。',
  },
  {
    id: 'goal',
    label: '今日目标',
    description: '按阅读会话计算的今日目标圆环。',
  },
  {
    id: 'tags',
    label: '我的标签',
    description: '常用标签及其真实关联数量。',
    countLabel: '标签数量',
    minCount: 3,
    maxCount: 8,
    defaultCount: 6,
  },
] as const;

export const DEFAULT_HOME_ORDER: HomeModuleId[] = [
  'continue',
  'recent',
  'notes',
  'statistics',
  'goal',
  'tags',
];
export const DEFAULT_HOME_HIDDEN: HomeModuleId[] = [];
export const DEFAULT_HOME_COUNTS = Object.fromEntries(
  HOME_MODULES.filter((module) => module.defaultCount).map((module) => [
    module.id,
    module.defaultCount,
  ]),
) as Record<string, number>;

const validIds = new Set<HomeModuleId>(DEFAULT_HOME_ORDER);

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function resolveHomeLayout(layout: Record<string, unknown>) {
  const requestedOrder = stringArray(layout.homeOrder).filter((id): id is HomeModuleId =>
    validIds.has(id as HomeModuleId),
  );
  const order = [
    ...requestedOrder.filter((id, index) => requestedOrder.indexOf(id) === index),
    ...DEFAULT_HOME_ORDER.filter((id) => !requestedOrder.includes(id)),
  ];
  const requestedHidden = stringArray(layout.homeHidden).filter((id): id is HomeModuleId =>
    validIds.has(id as HomeModuleId),
  );
  const hidden = [...new Set(requestedHidden)];
  const rawCounts =
    layout.homeCounts && typeof layout.homeCounts === 'object' && !Array.isArray(layout.homeCounts)
      ? (layout.homeCounts as Record<string, unknown>)
      : {};
  const counts = { ...DEFAULT_HOME_COUNTS };
  for (const module of HOME_MODULES) {
    if (!module.defaultCount) continue;
    const number = Number(rawCounts[module.id]);
    counts[module.id] = Number.isFinite(number)
      ? Math.min(module.maxCount ?? module.defaultCount, Math.max(module.minCount ?? 1, number))
      : module.defaultCount;
  }
  return { order, hidden, counts };
}
