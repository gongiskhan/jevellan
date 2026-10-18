import { derivedId } from './decision-items.js';
export const setupProposalId = (projectId: string, triggerId: string) => derivedId('setup', projectId, triggerId);
