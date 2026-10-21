// src/security/approvalRisk.ts — 审批风险的单一判定源
//
// 删除和宿主命令不能靠「上次已完全同意」复用，也不能只靠前端禁用按钮：
// 这些动作需要人在当前批次上再次明确确认。Runtime、写工具和 UI 共用同一组原因，
// 避免各层对“高危”的定义漂移。
import type { ApprovalRiskReason } from '../types.js';

export interface ApprovalRisk {
  highRisk: boolean;
  reasons: ApprovalRiskReason[];
}

/** 纯函数：批次风险只由操作类型与是否含宿主命令决定。 */
export function assessApprovalRisk(opts: {
  ops?: ReadonlyArray<string>;
  hasCommands?: boolean;
}): ApprovalRisk {
  const reasons: ApprovalRiskReason[] = [];
  if (opts.ops?.includes('delete')) reasons.push('delete');
  if (opts.hasCommands === true) reasons.push('host-command');
  return { highRisk: reasons.length > 0, reasons };
}
