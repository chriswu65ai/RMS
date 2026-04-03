import { Recommendation } from '../../types/models';

const recommendationStyles: Record<Recommendation | '', string> = {
  [Recommendation.Buy]: 'bg-green-100 text-green-800',
  [Recommendation.Hold]: 'bg-yellow-100 text-yellow-800',
  [Recommendation.Sell]: 'bg-rose-100 text-rose-800',
  [Recommendation.Avoid]: 'bg-slate-200 text-slate-700',
  '': 'bg-slate-100 text-slate-500',
};

const recommendationLabels: Record<Recommendation, string> = {
  [Recommendation.Buy]: 'Buy',
  [Recommendation.Hold]: 'Hold',
  [Recommendation.Sell]: 'Sell',
  [Recommendation.Avoid]: 'Avoid',
};

export function RecommendationBadge({ value }: { value: Recommendation | '' }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${recommendationStyles[value]}`}>{value ? recommendationLabels[value] : '—'}</span>;
}
