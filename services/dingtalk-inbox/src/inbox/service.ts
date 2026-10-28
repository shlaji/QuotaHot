import { DwsProcessError } from '../dws/runner.js';
import type { DwsRunner } from '../dws/runner.js';
import { SearchSchemaError } from '../dws/search.js';
import type { SearchResult } from '../dws/search.js';
import type { Capability, DingtalkMessage, DingtalkSubscription, DingtalkTarget, ErrorDto } from '../shared/types.js';
import type { InboxStore } from './store.js';

export type TargetDto = Pick<DingtalkTarget, 'targetType' | 'targetId' | 'displayName'>;
export type SubscriptionDto = Pick<DingtalkSubscription, 'subscriptionId' | 'targetType' | 'targetId' | 'state'> & {
  readonly failureCode?: string;
  readonly failureMessage?: string;
};
export interface ActiveTargetDto {
  readonly activeTarget: TargetDto | null;
  readonly listeningDesired: boolean;
  readonly subscriptionState: SubscriptionDto | null;
}

export type InboxEvent =
  | { readonly type: 'subscription.state'; readonly data: SubscriptionDto & { readonly occurredAt: string } }
  | { readonly type: 'message.received'; readonly data: {
    readonly targetType: DingtalkTarget['targetType']; readonly targetId: string;
    readonly subscriptionId: string; readonly message: Omit<DingtalkMessage, 'profileKey'>; readonly occurredAt: string;
  } }
  | { readonly type: 'message.send-state'; readonly data: {
    readonly targetType: DingtalkTarget['targetType']; readonly targetId: string;
    readonly clientMessageId: string; readonly message: Omit<DingtalkMessage, 'profileKey'>; readonly occurredAt: string;
  } };

export interface InboxEventSource {
  subscribe(listener: (event: InboxEvent) => void): () => void;
}

export interface InboxEventPublisher {
  publish(event: InboxEvent): void;
}

export interface InboxServiceConfig {
  readonly profileKey: string;
}

export class InboxService {
  private capability: Capability = { available: false, reason: 'DWS search runtime has not been verified' };
  private readonly searches = new Map<DingtalkTarget['targetType'], { readonly profileKey: string; readonly generation: symbol; readonly targets: readonly TargetDto[] }>();
  constructor(
    private readonly store: InboxStore,
    readonly runner: DwsRunner,
    private readonly config: InboxServiceConfig,
  ) {}

  getCapability(): Capability {
    return this.capability;
  }

  async search(targetType: DingtalkTarget['targetType'], query: string): Promise<SearchResult<TargetDto> | ErrorDto> {
    const profileKey = this.config.profileKey;
    const generation = Symbol();
    this.searches.set(targetType, { profileKey, generation, targets: [] });
    if (profileKey !== this.runner.profileKey) return { code: 'RuntimeUnavailable', message: 'DWS profile mismatch' };
    try {
      let result: SearchResult<TargetDto>;
      switch (targetType) {
        case 'person': {
          const people = await this.runner.searchPeople(query);
          result = { complete: people.complete, items: people.items.map(person => ({ targetType: 'person', targetId: person.userId, displayName: person.displayName })) };
          break;
        }
        case 'group': {
          const groups = await this.runner.searchGroups(query);
          result = { complete: groups.complete, items: groups.items.map(group => ({ targetType: 'group', targetId: group.openConversationId, displayName: group.displayName })) };
          break;
        }
        default: return assertNever(targetType);
      }
      if (this.searches.get(targetType)?.generation === generation && this.config.profileKey === profileKey) {
        this.searches.set(targetType, { profileKey, generation, targets: result.complete ? result.items : [] });
        this.capability = { available: true, reason: 'DWS search command succeeded; listener is not implemented' };
      }
      return result;
    } catch (error) {
      if (!(error instanceof DwsProcessError) && !(error instanceof SearchSchemaError)) throw error;
      this.capability = { available: false, reason: 'DWS search runtime unavailable or response invalid' };
      return { code: 'RuntimeUnavailable', message: this.capability.reason };
    }
  }

  getActiveTarget(): ActiveTargetDto {
    const target = this.store.getActiveTarget();
    if (target === null || target.profileKey !== this.config.profileKey) {
      return { activeTarget: null, listeningDesired: false, subscriptionState: null };
    }
    return {
      activeTarget: { targetType: target.targetType, targetId: target.targetId, displayName: target.displayName },
      listeningDesired: target.listeningDesired,
      subscriptionState: null,
    };
  }

  selectTarget(target: TargetDto): ErrorDto {
    const evidence = this.searches.get(target.targetType);
    const verified = evidence?.profileKey === this.config.profileKey && this.runner.profileKey === this.config.profileKey
      ? evidence.targets.find(candidate => candidate.targetId === target.targetId) : undefined;
    if (verified === undefined) return { code: 'InvalidTarget', message: 'Target requires current complete search evidence' };
    const now = new Date().toISOString();
    const stored = this.store.upsertTarget({ ...verified, profileKey: this.config.profileKey, createdAt: now, updatedAt: now });
    this.store.setActiveTarget(stored, false);
    return { code: 'RuntimeUnavailable', message: 'Target selected; listener is not implemented' };
  }
}

function assertNever(_value: never): never { throw new SearchSchemaError(); }
