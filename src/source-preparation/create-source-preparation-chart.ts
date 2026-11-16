import type {SourceBuildStages} from '../delivery/stages.ts';
import {createPreparationChart} from '../preparation/create-preparation-chart.ts';

/** Source preparation stops at actual artifact publication. Review and deployment are separate workflows. */
export function createSourcePreparationChart(config:SourceBuildStages){
 return createPreparationChart(config);
}
