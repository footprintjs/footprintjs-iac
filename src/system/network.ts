import { CapabilityBuilder } from './leaf.ts';
import { DeclarationScope, invokeScope } from './scope.ts';
import { choice, positiveInteger } from './property-values.ts';
import { readReference } from './references.ts';
import type { Capability, ServiceReference } from './types.ts';

export class SegmentBuilder extends CapabilityBuilder {
  constructor(group: string, id: string) { super(group, id, 'network', 'segment'); }
}
export class EndpointBuilder extends CapabilityBuilder {
  constructor(group: string, id: string) { super(group, id, 'network', 'endpoint'); }
  protocol(value: 'http' | 'https' | 'tcp' | 'udp'): this { return this.set('protocol', choice(value, ['http', 'https', 'tcp', 'udp'], 'endpoint protocol')); }
  port(value: number): this {
    positiveInteger(value, 'port');
    if (value > 65535) throw new Error('Endpoint port exceeds 65535');
    return this.set('port', value);
  }
  target(value: ServiceReference): this { return this.set('target', readReference(value, 'service')); }
}
export class NetworkScope extends DeclarationScope {
  private readonly capabilities: Capability[] = [];
  private readonly group: string;
  constructor(group: string) { super(); this.group = group; }
  addSegment(id: string, callback: (segment: SegmentBuilder) => SegmentBuilder | void = () => undefined): this {
    this.assertOpen();
    const segment = new SegmentBuilder(this.group, id);
    invokeScope(segment, callback);
    this.capabilities.push(segment.snapshot());
    return this;
  }
  addEndpoint(id: string, callback: (endpoint: EndpointBuilder) => EndpointBuilder | void): this {
    this.assertOpen();
    const endpoint = new EndpointBuilder(this.group, id);
    invokeScope(endpoint, callback);
    this.capabilities.push(endpoint.snapshot());
    return this;
  }
  /** @internal */ snapshot(): Capability[] { return [...this.capabilities]; }
}
