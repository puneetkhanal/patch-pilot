import { IssueState } from './types.js';
export const transitions: Record<IssueState, readonly IssueState[]> = {
  NEW:['TRIAGED','BLOCKED','CLOSED'], TRIAGED:['PLANNED_BATCH','BLOCKED','CLOSED'],
  PLANNED_BATCH:['IN_PROGRESS','TRIAGED','BLOCKED','CLOSED'], IN_PROGRESS:['READY_FOR_REVIEW','BLOCKED','CLOSED'],
  READY_FOR_REVIEW:['MERGED','RESOLVED','BLOCKED','CLOSED'], MERGED:['CLOSED'], RESOLVED:['CLOSED'],
  BLOCKED:['TRIAGED','NEW','CLOSED'], CLOSED:[]
};
export function canTransition(from: IssueState, to: IssueState) { return transitions[from].includes(to); }
