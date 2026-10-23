// tests/62_contract_policy.test.ts — 契约门禁必须读取已注册工具的真实权限/风险
import assert from 'node:assert/strict';
import test from 'node:test';
import { SUB_AGENT_SPECS, validateSpecs, type SubAgentSpec } from '../src/agents/specs.js';
import { TOOL_PERMISSION } from '../src/runtime/AgentRuntime.js';
import { buildRegistry } from '../src/tools/index.js';

test('62a) 动态工具缺少权限映射时契约校验报错，不再静默跳过', () => {
  const registry = buildRegistry();
  const spec: SubAgentSpec = {
    ...SUB_AGENT_SPECS[0],
    id: 'dynamic-permission',
    tools: ['dir_stats', 'submit_finding', 'mcp_weather'],
    permissions: ['misc:read', 'agent:report', 'mcp:call'],
  };
  const issues = validateSpecs([spec], TOOL_PERMISSION, [...registry.names(), 'mcp_weather']);
  assert.ok(
    issues.some((i) => i.level === 'error' && /工具未声明权限映射: mcp_weather/.test(i.message)),
    JSON.stringify(issues),
  );
});

test('62b) 动态工具提供真实权限映射后可通过，且仍执行不多不少校验', () => {
  const registry = buildRegistry();
  const policy = registry.policySnapshot();
  const spec: SubAgentSpec = {
    ...SUB_AGENT_SPECS[0],
    id: 'dynamic-permission-ok',
    tools: ['dir_stats', 'submit_finding', 'mcp_weather'],
    permissions: ['misc:read', 'agent:report', 'mcp:call'],
    maxRiskLevel: 'high',
  };
  const issues = validateSpecs([spec], TOOL_PERMISSION, [...registry.names(), 'mcp_weather'], {
    toolPermissionByName: { ...policy.permissions, mcp_weather: 'mcp:call' },
    toolRiskLevel: { ...policy.riskLevels, mcp_weather: 'high' },
  });
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
});

test('62c) spec.maxRiskLevel 被真正校验', () => {
  const registry = buildRegistry();
  const policy = registry.policySnapshot();
  const spec: SubAgentSpec = {
    ...SUB_AGENT_SPECS[0],
    id: 'risk-overflow',
    tools: ['dir_stats', 'submit_finding', 'run_command'],
    permissions: ['misc:read', 'agent:report', 'codebase:write'],
    maxRiskLevel: 'safe',
  };
  const issues = validateSpecs([spec], TOOL_PERMISSION, registry.names(), {
    toolPermissionByName: policy.permissions,
    toolRiskLevel: policy.riskLevels,
  });
  assert.ok(
    issues.some((i) => i.level === 'error' && /工具风险等级越界: run_command/.test(i.message)),
    JSON.stringify(issues),
  );
});
