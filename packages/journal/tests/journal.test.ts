import { describe, expect, it } from 'vitest';
import { Journal } from '../src/index';

describe('Journal', () => {
  it('stores and filters entries by type', () => {
    const journal = new Journal();

    journal.add({
      id: '1',
      timestamp: 1,
      type: 'plan',
      payload: { steps: 3 }
    });

    journal.add({
      id: '2',
      timestamp: 2,
      type: 'commit',
      payload: { success: true }
    });

    const plans = journal.filterByType('plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe('1');
  });
});
