// Chat event cards: one sentence per coordinator event (D215). `name` is a quoted thread title or `a thread`.
export const UNKNOWN_THREAD_NAME = 'a thread';
export const quotedTitle = (title: string): string => `"${title}"`;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const eventCopy = {
  reportProgress: (name: string) => sentence(`${name} reported progress`),
  reportDone: (name: string) => sentence(`${name} is done`),
  reportDecision: (name: string) => sentence(`${name} needs a decision`),
  reportBlocked: (name: string) => sentence(`${name} is blocked`),
  prOpened: (name: string, n: number | undefined) => sentence(`${name} opened ${n ? `pull request #${n}` : 'a pull request'}`),
  prUpdated: (name: string, n: number | undefined) => sentence(`${name} updated ${n ? `pull request #${n}` : 'its pull request'}`),
  mainPublished: (name: string) => sentence(`${name} published to main`),
  checkoutCompleted: (name: string) => sentence(`${name} completed in your checkout`),
  noChanges: (name: string) => sentence(`${name} concluded without changes`),
  testsFailed: (name: string, attempts: number) => `Tests failed ${attempts === 1 ? 'once' : `${attempts} times`} in ${name}`,
  interruptedRestart: (name: string) => sentence(`${name} was interrupted by a restart`),
  interruptedTimeout: (name: string) => sentence(`${name} timed out`),
  interruptedFailed: (name: string) => sentence(`${name} failed`),
  interruptedStopped: (name: string) => sentence(`${name} was stopped`),
  ownerStopped: (name: string) => `You stopped ${name}`,
  answered: (question: string) => `You answered: ${question}`,
  answer: (optionLabel: string | undefined, text: string | undefined) => optionLabel ? `${optionLabel}${text ? `. ${text}` : ''}` : text ?? '',
  checksFailed: (name: string, n: number) => `Checks failing on pull request #${n} of ${name}`,
  checksPassed: (name: string, n: number) => `Checks passing on pull request #${n} of ${name}`,
  prMerged: (name: string, n: number) => `Pull request #${n} of ${name} was merged`,
  prClosed: (name: string, n: number) => `Pull request #${n} of ${name} was closed without merging`,
  prConflict: (name: string, n: number) => `Pull request #${n} of ${name} has conflicts`,
  mail: (name: string, subject: string) => `Mail from ${name}: ${subject}`,
  ownerStarted: (name: string) => `You started ${name}`,
  ownerWorked: (name: string) => `You worked on ${name} in a terminal`,
  ownerWrote: (name: string) => `You wrote to ${name}`,
  overridden: (name: string) => `You changed ${name}`,
} as const;

export const SETTINGS_CHANGED_EVENT = 'Project settings changed';
export const threadResolved = (title: string) => `Resolved "${title}"`;
export const automaticFixEvent = (number: number, outcome: string) => `Pull request #${number}: automatic fix ${outcome}`;
export const SETUP_REQUESTED_EVENT = 'Setup recommendations requested';
