import type { CombinedRecorder } from 'footprintjs';
import type { DeploymentChart, DeploymentChartObserver } from '../progress/chart.ts';

export const INTERNAL_CHART_RECORDER_ID = 'iac-internal-deployment-chart';
export interface ChartPublication { chart: DeploymentChart; observers: readonly DeploymentChartObserver[] }

/** FootPrint clears recorders before onRunStart; publication therefore survives reset and precedes traversal. */
export function chartObserver(publication: ChartPublication) {
  const status = { published: false, failed: 0 };
  const recorder: CombinedRecorder = { id: INTERNAL_CHART_RECORDER_ID, onRunStart() {
    status.published = true;
    for (const observer of publication.observers) {
      try { observer.onChart(publication.chart); } catch { status.failed++; }
    }
  } };
  return { recorder, status };
}
