import { decide, flowChart, type FlowChart } from 'footprintjs';
import { AdapterFlowScope, adapterFlowScopeFactory } from './scope.ts';
import type { AdapterFlowContext, AdapterFlowPhase } from './types.ts';

export interface AdapterPhase {
  id: string; name: string; phase: AdapterFlowPhase;
  /** Public facts are emitted explicitly by the phase; private transport output stays outside scope. */
  run(scope: AdapterFlowScope): Promise<void>;
}
/** One construction site for the actual provider boundaries. Failed phases cannot enter later effects. */
export function createAdapterFlowChart(binding: AdapterFlowContext, phases: readonly AdapterPhase[], next?:FlowChart<any,any>) {
  let chart = flowChart<void,AdapterFlowScope>('Admit adapter operation', scope => {
    void scope.getValue('adapterFlowInput');
    scope.setValue('adapterFlowOutcome', { status: 'passed' });
    scope.setValue('adapterFlowPassed', true);
  }, 'adapter-admit').setScopeFactory(adapterFlowScopeFactory);
  for (const phase of phases) {
    chart = chart.addDeciderFunction(`Proceed to ${phase.name}`, scope => decide(scope, [
      { when: { adapterFlowPassed: { eq: true } }, then: phase.id, label: 'Previous provider boundary confirmed' },
    ], `skip-${phase.id}`), `gate-${phase.id}`)
      .addFunctionBranch(phase.id, phase.name, async scope => {
        scope.progress(binding, phase.phase, 'running');
        try { await phase.run(scope); scope.progress(binding, phase.phase, 'passed'); }
        catch { const outcome = { status: 'unknown' as const, code: 'adapter-effect-unconfirmed' }; scope.setValue('adapterFlowOutcome', outcome); scope.setValue('adapterFlowPassed', false); scope.progress(binding, phase.phase, 'unknown'); }
      })
      .addFunctionBranch(`skip-${phase.id}`, `Do not run ${phase.name}`, () => undefined)
      .setDefault(`skip-${phase.id}`).end();
  }
  if(next)chart=chart.addDeciderFunction('May the delegated provider run?',scope=>decide(scope,[{when:{adapterFlowPassed:{eq:true}},then:'adapter-delegate',label:'All guard observations passed'}],'adapter-refused'),'adapter-delegate-gate')
    .addSubFlowChartBranch('adapter-delegate',next,'Guarded provider operation',{
      inputMapper:scope=>({adapterFlowInput:(scope as Record<string,unknown>).adapterFlowInput}),outputMapper:output=>({adapterFlowOutcome:(output as Record<string,unknown>).adapterFlowOutcome}),
    }).addFunctionBranch('adapter-refused','Keep the provider unchanged',()=>undefined).setDefault('adapter-refused').end();
  return chart.build();
}
