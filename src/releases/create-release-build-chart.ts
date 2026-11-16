import type { SourceBuildStages } from '../delivery/stages.ts';
import {createPreparationChart} from '../preparation/create-preparation-chart.ts';

/** Build once. Environment promotion is a separate chart over the sealed artifacts. */
export function createReleaseBuildChart(config: SourceBuildStages) {
  return createPreparationChart(config);
}
