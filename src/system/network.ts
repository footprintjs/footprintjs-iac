import { CapabilityBuilder } from './leaf.ts';
import { checkHandle, issueHandle, type NetworkHandle } from './handles.ts';
import { DeclarationScope, invokeScope } from './scope.ts';
import { choice, positiveInteger } from './property-values.ts';
import { readReference } from './references.ts';
import type { Capability, ServiceReference } from './types.ts';

export class SegmentBuilder extends CapabilityBuilder {
  constructor(group: string, id: string) { super(group, id, 'network', 'segment'); }
}
export class EndpointBuilder extends CapabilityBuilder {
  private readonly handles?: ReadonlySet<object>;
  constructor(group: string, id: string, handles?: ReadonlySet<object>) {
    super(group, id, 'network', 'endpoint'); this.handles = handles;
  }
  protocol(value: 'http' | 'https' | 'tcp' | 'udp'): this { return this.set('protocol', choice(value, ['http', 'https', 'tcp', 'udp'], 'endpoint protocol')); }
  port(value: number): this {
    positiveInteger(value, 'port');
    if (value > 65535) throw new Error('Endpoint port exceeds 65535');
    return this.set('port', value);
  }
  target(value: ServiceReference): this {
    checkHandle(this.handles, value);
    return this.set('target', readReference(value, 'service'));
  }
}
export class NetworkScope extends DeclarationScope {
  private readonly capabilities: Capability[] = [];
  private readonly group: string;
  private readonly handles: Set<object>;
  constructor(group: string, handles = new Set<object>()) { super(); this.group = group; this.handles = handles; }
  segment(id: string, callback?: (segment: SegmentBuilder) => SegmentBuilder | void): NetworkHandle {
    this.addSegment(id, callback);
    return issueHandle(this.handles, 'network', `${this.group}.${id}`);
  }
  endpoint(id: string, callback: (endpoint: EndpointBuilder) => EndpointBuilder | void): NetworkHandle {
    this.addEndpoint(id, callback);
    return issueHandle(this.handles, 'network', `${this.group}.${id}`);
  }
  addSegment(id: string, callback: (segment: SegmentBuilder) => SegmentBuilder | void = () => undefined): this {
    this.assertOpen();
    const segment = new SegmentBuilder(this.group, id);
    invokeScope(segment, callback);
    this.capabilities.push(segment.snapshot());
    return this;
  }
  addEndpoint(id: string, callback: (endpoint: EndpointBuilder) => EndpointBuilder | void): this {
    this.assertOpen();
    const endpoint = new EndpointBuilder(this.group, id, this.handles);
    invokeScope(endpoint, callback);
    this.capabilities.push(endpoint.snapshot());
    return this;
  }
  /** @internal */ snapshot(): Capability[] { return [...this.capabilities]; }
}
