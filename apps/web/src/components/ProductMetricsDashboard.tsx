import type { ReactNode } from "react";
import {
  AlertTriangle,
  Bug,
  Check,
  Clock,
  DollarSign,
  Gauge,
  RotateCcw,
  ShieldCheck,
  TestTube2,
  UserCheck
} from "lucide-react";
import { failureTypeLabels, formatCurrency } from "@/lib/professionalMode";
import {
  formatDurationCompact,
  formatMetricNumber,
  formatMetricPercent,
  type FailureReasonKey,
  type ProductMetricsDashboard as ProductMetrics
} from "@/lib/productMetrics";

interface ProductMetricsDashboardProps {
  metrics: ProductMetrics | null;
}

const failureReasonLabels: Record<FailureReasonKey, string> = {
  ...failureTypeLabels,
  cancelled: "运行取消",
  unknown: "未分类失败"
};

export function ProductMetricsDashboard({ metrics }: ProductMetricsDashboardProps) {
  return (
    <section aria-label="成本和产品指标" className="metrics-section">
      <div className="panel-title metrics-title">
        <div>
          <span className="eyebrow compact">
            <Gauge size={15} />
            指标仪表盘
          </span>
          <h2>成本和产品指标</h2>
        </div>
        {metrics ? (
          <span className={`status-pill ${metrics.auditCompleteness.chainValid === false ? "red" : "blue"}`}>
            {metrics.auditCompleteness.checkedEvents} 条审计事件
          </span>
        ) : null}
      </div>

      {metrics ? (
        <div className="product-metric-grid">
          <MetricCard
            detail={
              metrics.requirementToPr.count > 0
                ? `${metrics.requirementToPr.count} 个需求已有 PR 交付记录`
                : "暂无需求到 PR 的交付记录"
            }
            icon={<Clock size={17} />}
            label="需求到 PR 时间"
            tone="blue"
            value={formatDurationCompact(metrics.requirementToPr.averageMs)}
          />
          <MetricCard
            detail={`${metrics.autonomousCompletion.numerator}/${metrics.autonomousCompletion.denominator} 个已结束 run 成功且无审批或返工拒绝`}
            icon={<Gauge size={17} />}
            label="自主完成率"
            tone={rateTone(metrics.autonomousCompletion.rate)}
            value={formatMetricPercent(metrics.autonomousCompletion)}
          />
          <MetricCard
            detail={`${metrics.firstTestPass.numerator}/${metrics.firstTestPass.denominator} 组首个测试证据通过`}
            icon={<TestTube2 size={17} />}
            label="首次测试通过率"
            tone={rateTone(metrics.firstTestPass.rate)}
            value={formatMetricPercent(metrics.firstTestPass)}
          />
          <MetricCard
            detail={`审批 ${metrics.humanInterventions.approvalCount} · 验收 ${metrics.humanInterventions.acceptanceDecisionCount} · 返工拒绝 ${metrics.humanInterventions.rejectionCount}`}
            icon={<UserCheck size={17} />}
            label="人类介入次数"
            tone={metrics.humanInterventions.total > 0 ? "amber" : "green"}
            value={`${metrics.humanInterventions.total} 次`}
          />
          <MetricCard
            detail={
              metrics.costPerAcceptedPr.acceptedPrCount > 0
                ? `${formatCurrency(metrics.costPerAcceptedPr.totalCostUsd)} 总成本 / ${metrics.costPerAcceptedPr.acceptedPrCount} 个已接受 PR`
                : `${formatCurrency(metrics.costPerAcceptedPr.totalCostUsd)} 总成本，暂无已接受 PR`
            }
            icon={<DollarSign size={17} />}
            label="成本 / 接受 PR"
            tone="blue"
            value={metrics.costPerAcceptedPr.valueUsd === null ? "暂无" : formatCurrency(metrics.costPerAcceptedPr.valueUsd)}
          />
          <MetricCard
            detail={`${metrics.reproductionSuccess.numerator}/${metrics.reproductionSuccess.denominator} 个已尝试 bug 被复现或进入修复闭环`}
            icon={<Bug size={17} />}
            label="复现成功率"
            tone={rateTone(metrics.reproductionSuccess.rate)}
            value={formatMetricPercent(metrics.reproductionSuccess)}
          />
          <MetricCard
            detail={`${metrics.auditCompleteness.numerator}/${metrics.auditCompleteness.denominator} 个关键交付记录有 AuditEvent${
              metrics.auditCompleteness.chainValid === false ? "，hash chain 校验失败" : ""
            }`}
            icon={<ShieldCheck size={17} />}
            label="审计完整率"
            tone={metrics.auditCompleteness.chainValid === false ? "red" : rateTone(metrics.auditCompleteness.rate)}
            value={formatMetricPercent(metrics.auditCompleteness)}
          />
          <MetricCard
            detail={
              metrics.reworkRounds.workItemCount > 0
                ? `${metrics.reworkRounds.workItemCount} 个工作项 · 平均 ${formatMetricNumber(metrics.reworkRounds.average ?? 0, 1)} 轮 · 最高 ${metrics.reworkRounds.max} 轮`
                : "暂无工作项返工记录"
            }
            icon={<RotateCcw size={17} />}
            label="返工轮次"
            tone={metrics.reworkRounds.total > 0 ? "amber" : "green"}
            value={`${metrics.reworkRounds.total} 轮`}
          />
          <MetricCard
            detail={`${metrics.finalAcceptance.numerator}/${metrics.finalAcceptance.denominator} 个工作项的最新验收决策为接受`}
            icon={<Check size={17} />}
            label="最终接受率"
            tone={rateTone(metrics.finalAcceptance.rate)}
            value={formatMetricPercent(metrics.finalAcceptance)}
          />

          <article className="product-metric-card product-metric-wide">
            <span className="product-metric-label">
              <AlertTriangle size={17} />
              失败原因
            </span>
            {metrics.failureReasons.length ? (
              <div className="failure-reason-list">
                {metrics.failureReasons.map((reason) => (
                  <div className="failure-reason-row" key={reason.key}>
                    <span>
                      <strong>{failureReasonLabels[reason.key]}</strong>
                      <small>
                        {reason.count} 次 · {formatCurrency(reason.costUsd)} 成本
                      </small>
                    </span>
                    <span className="status-pill red">{reason.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-copy compact-empty">暂无失败原因，已结束 run 没有失败或取消记录。</p>
            )}
          </article>
        </div>
      ) : (
        <p className="empty-copy">正在等待 snapshot，同步后会按真实运行、测试、审批、PR、bug 和审计事件计算指标。</p>
      )}
    </section>
  );
}

function MetricCard({
  detail,
  icon,
  label,
  tone,
  value
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  tone: "green" | "blue" | "amber" | "red";
  value: string;
}) {
  return (
    <article className={`product-metric-card ${tone}`}>
      <span className="product-metric-label">
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function rateTone(rate: number | null): "green" | "blue" | "amber" | "red" {
  if (rate === null) return "blue";
  if (rate >= 90) return "green";
  if (rate >= 70) return "blue";
  if (rate >= 50) return "amber";
  return "red";
}
