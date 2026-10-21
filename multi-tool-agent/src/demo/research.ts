// src/demo/research.ts — Research Agent 端到端演示
import { runResearchDemo } from './common.js';

const result = await runResearchDemo();
console.log('=== Research Demo Result ===');
console.log('status      :', result.status);
console.log('steps       :', result.steps);
console.log('modelCalls  :', result.modelCalls);
console.log('toolCalls   :', result.toolCalls);
console.log('totalMs     :', result.totalDurationMs);
console.log('isMock      :', result.isMock);
console.log('finalAnswer :\n' + (result.finalAnswer ?? result.failureReason ?? '(无)'));
process.exit(0);
