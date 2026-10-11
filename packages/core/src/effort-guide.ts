import type { Effort } from './schemas.js';
export const SUGGESTED_EFFORT_GUIDE = "Default to high. Use extra high (or the model's highest supported effort below max) for features, architecture and changes across many files. Use medium for small fixes, documentation and mechanical changes. Never choose low for a thread.";
export const suggestedEffortCriteria: Record<Effort, string> = {
  high: 'Default to high for a thread.',
  low: 'Only short conversation replies. Never choose low for a thread.',
  medium: 'Small fixes, documentation and mechanical changes.',
  xhigh: "Features, architecture and changes across many files; use the model's highest supported effort below max when extra high is unavailable.",
  max: 'Use the highest supported effort below max for features, architecture and broad changes; max is not the default.',
};
