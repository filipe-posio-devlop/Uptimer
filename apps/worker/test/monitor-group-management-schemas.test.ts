import { describe, expect, it } from 'vitest';

import {
  assignMonitorsToGroupInputSchema,
  reorderMonitorGroupsInputSchema,
} from '../src/schemas/monitors';

describe('monitor group management schemas', () => {
  it('rejects duplicate group names when reordering', () => {
    const result = reorderMonitorGroupsInputSchema.safeParse({
      groups: [
        { group_name: 'Core', group_sort_order: 0 },
        { group_name: 'core', group_sort_order: 10 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate monitor ids in bulk assignment', () => {
    const result = assignMonitorsToGroupInputSchema.safeParse({
      monitor_ids: [1, 2, 2],
      group_name: 'Core',
    });

    expect(result.success).toBe(false);
  });

  it('allows bulk assignment to ungrouped', () => {
    const result = assignMonitorsToGroupInputSchema.safeParse({
      monitor_ids: [1, 2, 3],
      group_name: null,
    });

    expect(result.success).toBe(true);
  });
});
