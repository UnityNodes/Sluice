// Pre-canned predicates the Discord bot offers as /sluice-watch choices.
// Add your own to the list; the bot reads names from here.

module.exports = {
  'whale-100k': {
    label: '🐋 100k+ CSPR transfers',
    predicate: {
      and: [
        { field: 'amount', op: 'gte', value: '100000000000000' },
      ],
    },
  },
  'whale-1m': {
    label: '🐋🐋 1M+ CSPR transfers',
    predicate: {
      and: [
        { field: 'amount', op: 'gte', value: '1000000000000000' },
      ],
    },
  },
  'micro-payments': {
    label: '💸 sub-10 CSPR (likely tipping)',
    predicate: {
      and: [
        { field: 'amount', op: 'lt', value: '10000000000' },
      ],
    },
  },
  'round-numbers': {
    label: '🎯 transfers ending in 000000000 (round CSPR amounts)',
    predicate: {
      and: [
        { field: 'amount', op: 'ends_with', value: '000000000' },
        { field: 'amount', op: 'gte', value: '5000000000' },
      ],
    },
  },
};
