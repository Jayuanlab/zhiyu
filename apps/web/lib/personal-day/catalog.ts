/** Bounded choices, not model-authored medical prescriptions. Nutrition is
 * computed only from a user's explicitly verified label/catalog entries. */
import type { Food, MealIngredient, DayItem } from './contracts';
export const EXERCISES = [
  {
    id: 'walk_short',
    name: '短时舒适步行',
    minutes: 15,
    equipment: 'none',
    tags: ['walk'],
    steps: [
      '按舒适速度开始，留出准备和放缓时间。',
      '以自身可耐受程度为准；不适时停止并记录。',
    ],
    source: 'https://www.nhs.uk/live-well/exercise/walking-for-health/',
  },
  {
    id: 'walk_regular',
    name: '舒适步行',
    minutes: 30,
    equipment: 'none',
    tags: ['walk'],
    steps: [
      '按舒适速度行走，包含开始和结束的缓和活动。',
      '记录实际用时与主观感受，不追求强制配速。',
    ],
    source: 'https://www.nhs.uk/live-well/exercise/walking-for-health/',
  },
  {
    id: 'home_strength',
    name: '居家基础力量活动',
    minutes: 25,
    equipment: 'chair',
    tags: ['strength'],
    steps: [
      '准备稳固椅子，先做温和热身。',
      '依个人耐受完成坐站、靠墙俯卧撑、站姿提踵；每个动作从少量开始，动作间充分休息。',
      '放缓活动，记录实际动作、次数与不适；不适时停止。',
    ],
    source: 'https://www.nhs.uk/live-well/exercise/strength-exercises/',
  },
  {
    id: 'mobility',
    name: '温和活动与伸展',
    minutes: 10,
    equipment: 'none',
    tags: ['mobility'],
    steps: [
      '在舒适范围内做温和活动，不强压或追求幅度。',
      '包含准备和结束时间；有疼痛或不适时停止。',
    ],
    source: 'https://www.nhs.uk/live-well/exercise/flexibility-exercises/',
  },
] as const;
export const RECIPES = [
  {
    id: 'oats_egg',
    name: '燕麦、鸡蛋与水果',
    meal: 'breakfast',
    mode: 'cook',
    minutes: 25,
    allergens: ['燕麦', '鸡蛋', '蛋', '麸质'],
    ingredients: [
      { name: '燕麦', grams: 50, state: 'raw' },
      { name: '鸡蛋', grams: 50, state: 'raw' },
      { name: '水果', grams: 150, state: 'raw' },
    ],
    steps: [
      '燕麦煮熟，鸡蛋充分加热，搭配新鲜水果。',
      '按实际食欲与已确认的个人要求调整份量并记录。',
    ],
  },
  {
    id: 'soy_bread',
    name: '豆浆、全麦面包与水果',
    meal: 'breakfast',
    mode: 'outside',
    minutes: 20,
    allergens: ['大豆', '豆', '小麦', '麸质'],
    ingredients: [
      { name: '豆浆', grams: 250, state: 'packaged' },
      { name: '全麦面包', grams: 70, state: 'packaged' },
      { name: '水果', grams: 150, state: 'raw' },
    ],
    steps: ['核对包装配料与过敏原，选择份量明确的食物。'],
  },
  {
    id: 'rice_chicken',
    name: '米饭、鸡肉与蔬菜',
    meal: 'lunch',
    mode: 'cook',
    minutes: 50,
    allergens: ['鸡肉'],
    ingredients: [
      { name: '米饭', grams: 180, state: 'cooked' },
      { name: '鸡肉', grams: 120, state: 'raw' },
      { name: '蔬菜', grams: 250, state: 'raw' },
    ],
    steps: [
      '鸡肉充分做熟，搭配米饭和蔬菜。',
      '酱料、烹调油与实际食用量另行记录，营养汇总不自动忽略它们。',
    ],
  },
  {
    id: 'rice_tofu',
    name: '米饭、豆腐与蔬菜',
    meal: 'dinner',
    mode: 'cook',
    minutes: 45,
    allergens: ['大豆', '豆'],
    ingredients: [
      { name: '米饭', grams: 150, state: 'cooked' },
      { name: '豆腐', grams: 150, state: 'raw' },
      { name: '蔬菜', grams: 250, state: 'raw' },
    ],
    steps: [
      '豆腐和蔬菜充分处理，搭配主食。',
      '份量为可编辑的搭配起点，非个人能量处方。',
    ],
  },
  {
    id: 'outside_lunch',
    name: '外食：主食、蛋白质食物与蔬菜',
    meal: 'lunch',
    mode: 'outside',
    minutes: 35,
    allergens: ['成分待核对'],
    ingredients: [
      { name: '主食', grams: 180, state: 'cooked' },
      { name: '蛋白质食物', grams: 120, state: 'cooked' },
      { name: '蔬菜', grams: 250, state: 'cooked' },
    ],
    steps: [
      '在购买前核对实际食物和过敏原。',
      '外食重量仅为估算，记录实际选择后再计算营养。',
    ],
  },
  {
    id: 'outside_dinner',
    name: '简便晚餐：主食、蛋白质食物与蔬菜',
    meal: 'dinner',
    mode: 'outside',
    minutes: 30,
    allergens: ['成分待核对'],
    ingredients: [
      { name: '主食', grams: 150, state: 'cooked' },
      { name: '蛋白质食物', grams: 120, state: 'cooked' },
      { name: '蔬菜', grams: 250, state: 'cooked' },
    ],
    steps: [
      '按就餐条件选择可以核对成分的餐食。',
      '不能核对过敏原时暂不采用该餐食选项。',
    ],
  },
] as const;
export const GENERAL_SOURCES = [
  {
    id: 'guideline:activity',
    title: 'WHO 身体活动指南：一般依据',
    url: 'https://www.who.int/europe/news-room/fact-sheets/item/physical-activity',
  },
  {
    id: 'guideline:diet',
    title: '中国居民膳食指南：食物多样与吃动平衡',
    url: 'https://sfncc.caas.cn/xyyw/79c86454ef84437eb3e0df055deffd56.htm',
  },
];
export const CATALOG_CITATIONS = [
  ...GENERAL_SOURCES,
  ...Array.from(
    new Map(
      EXERCISES.map((exercise) => [
        exercise.source,
        {
          id: exercise.source,
          title: exercise.name + '：目录动作来源',
          url: exercise.source,
        },
      ]),
    ).values(),
  ),
];
export function ingredientNutrition(ingredient: MealIngredient, foods: Food[]) {
  const food = foods.find(
    (f) =>
      f.id === ingredient.foodId && f.verified && f.state === ingredient.state,
  );
  if (!food) return null;
  return {
    kcal: food.kcal === null ? null : (food.kcal * ingredient.grams) / 100,
    protein:
      food.protein === null ? null : (food.protein * ingredient.grams) / 100,
    carbs: food.carbs === null ? null : (food.carbs * ingredient.grams) / 100,
    fat: food.fat === null ? null : (food.fat * ingredient.grams) / 100,
    source: food.source,
  };
}
export function nutritionSummary(items: DayItem[], foods: Food[]) {
  const ingredients = items
      .filter(
        (i) => i.kind === 'meal' && !['skipped', 'canceled'].includes(i.status),
      )
      .flatMap((i) => i.actual?.ingredients ?? i.ingredients ?? []),
    values = ingredients.map((i) => ingredientNutrition(i, foods));
  const total = (key: 'kcal' | 'protein' | 'carbs' | 'fat') => {
    const known = values.flatMap((v) => (v?.[key] == null ? [] : [v[key]!]));
    return known.length ? known.reduce((n, value) => n + value, 0) : null;
  };
  return {
    kcal: total('kcal'),
    protein: total('protein'),
    carbs: total('carbs'),
    fat: total('fat'),
    complete:
      ingredients.length > 0 &&
      values.every((v) => v && Object.values(v).every((x) => x !== null)),
    known: values.filter((v) => v !== null).length,
    count: ingredients.length,
  };
}
