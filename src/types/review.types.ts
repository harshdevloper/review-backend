export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Review {
  id: string;
  userName: string;
  userImage: string;
  score: number;
  title: string | null;
  text: string;
  date: string;
  replyDate: string | null;
  replyText: string | null;
  version: string | null;
  thumbsUp: number;
  language: string;
  sentiment: Sentiment;
}

export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface TimelinePoint {
  month: string;
  count: number;
  avgRating: number;
}

export interface VersionBreakdownPoint {
  version: string;
  count: number;
}

export interface HeatmapPoint {
  day: number;
  hour: number;
  count: number;
}

export interface KeywordPoint {
  word: string;
  count: number;
}

export interface LanguagePoint {
  language: string;
  count: number;
}

export interface Analytics {
  ratingDistribution: RatingDistribution;
  sentiment: Record<Sentiment, number>;
  timeline: TimelinePoint[];
  versionBreakdown: VersionBreakdownPoint[];
  heatmap: HeatmapPoint[];
  topKeywords: KeywordPoint[];
  avgReviewLength: number;
  developerReplyPercentage: number;
  languageDistribution: LanguagePoint[];
}

export interface ReviewFetchResult {
  packageName: string;
  app: import('./app.types.js').AppDetails;
  reviews: Review[];
  analytics: Analytics;
  fetchedAt: string;
}
