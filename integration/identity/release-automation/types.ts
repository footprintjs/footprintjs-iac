import type {SourceAdapter} from '../../../src/delivery/types.ts';
import type {ReleaseCatalog,ResolvedReleaseChoice} from '../../../src/releases/types.ts';
import type {ReleaseAutomationContext,ReleaseAutomationDefinition} from '../../../src/release-automation/types.ts';
import type {NeoPreparedRelease,NeoReleasePipelineOptions} from '../release-pipeline/types.ts';
import type {NeoImageBuildOptions,buildNeoImages} from '../build-neo-images.ts';

/** Trusted host composition; UI callers supply only registered source/attempt IDs. */
export interface NeoReleaseAutomationOptions extends Omit<NeoReleasePipelineOptions,'id'|'directory'|'releases'> {
  id:string;label?:string;directory:string;catalog:ReleaseCatalog;
  baselineReleases:readonly NeoPreparedRelease[];
  automatic:ReleaseAutomationDefinition['automatic'];
  /** Version all trusted function/adapter contracts when changing their implementation. */
  configurationDigest:string;
  sourceAdapter(choice:ResolvedReleaseChoice,context:ReleaseAutomationContext):SourceAdapter|Promise<SourceAdapter>;
  buildImages?:typeof buildNeoImages;buildOptions?:NeoImageBuildOptions;
}
