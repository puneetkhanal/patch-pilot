import {describe,it,expect} from 'vitest'; import {canTransition} from '../src/domain/workflow.js';
describe('workflow',()=>{it('accepts valid transition',()=>expect(canTransition('NEW','TRIAGED')).toBe(true));it('rejects invalid transition',()=>expect(canTransition('NEW','MERGED')).toBe(false));it('closed is terminal',()=>expect(canTransition('CLOSED','NEW')).toBe(false));});
