import { parseNaturalLanguage } from '../src/ai';

describe('parseNaturalLanguage', () => {
  test('over 100k CSPR + to <hex>', () => {
    const r = parseNaturalLanguage('watch transfers over 100k cspr to dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c');
    expect(r.predicate).not.toBeNull();
    expect(r.predicate!.and).toContainEqual({ field: 'amount', op: 'gte', value: '100000000000000' });
    expect(r.predicate!.and).toContainEqual({ field: 'to_account_hash', op: 'eq', value: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' });
  });

  // "more than" and "at least" are the phrasings people reach for first, so
  // every synonym in the threshold grammar gets pinned here.
  test.each([
    ['more than 100 cspr', 'gte'],
    ['at least 100 cspr', 'gte'],
    ['no less than 100 cspr', 'gte'],
    ['over 100 cspr', 'gte'],
    ['above 100 cspr', 'gte'],
    ['greater than 100 cspr', 'gte'],
    ['at most 100 cspr', 'lte'],
    ['no more than 100 cspr', 'lte'],
    ['up to 100 cspr', 'lte'],
    ['under 100 cspr', 'lte'],
    ['below 100 cspr', 'lte'],
    ['less than 100 cspr', 'lte'],
  ])('threshold phrasing %p parses as %s', (prompt, op) => {
    const r = parseNaturalLanguage(`alert me when someone transfers ${prompt}`);
    expect(r.predicate).not.toBeNull();
    expect(r.predicate!.and).toContainEqual({ field: 'amount', op, value: '100000000000' });
  });

  // "no more than" embeds "more than", "no less than" embeds "less than". A
  // naive alternation matches both and emits a contradictory gte + lte pair.
  test.each([
    ['no more than 50 cspr', 'lte', 'gte'],
    ['no less than 50 cspr', 'gte', 'lte'],
  ])('%p yields only %s, never %s', (prompt, want, unwanted) => {
    const conds = parseNaturalLanguage(`transfers ${prompt}`).predicate!.and as Array<{ field: string; op: string }>;
    const amounts = conds.filter((c) => c.field === 'amount');
    expect(amounts).toHaveLength(1);
    expect(amounts[0].op).toBe(want);
    expect(amounts.some((c) => c.op === unwanted)).toBe(false);
  });

  test('range "between 5 and 50 cspr" emits gte + lte', () => {
    const r = parseNaturalLanguage('transfers between 5 and 50 cspr');
    expect(r.predicate!.and).toContainEqual({ field: 'amount', op: 'gte', value: '5000000000' });
    expect(r.predicate!.and).toContainEqual({ field: 'amount', op: 'lte', value: '50000000000' });
  });

  test('million / billion suffixes', () => {
    const m = parseNaturalLanguage('over 5 million cspr');
    expect(m.predicate!.and[0].value).toBe('5000000000000000');
    const b = parseNaturalLanguage('over 1 billion cspr');
    expect(b.predicate!.and[0].value).toBe('1000000000000000000');
  });

  test('"ending in" → ends_with', () => {
    const r = parseNaturalLanguage('transfers ending in 000000000');
    expect(r.predicate!.and).toContainEqual({ field: 'amount', op: 'ends_with', value: '000000000' });
  });

  test('block height "above 8m"', () => {
    const r = parseNaturalLanguage('block above 8m');
    expect(r.predicate!.and).toContainEqual({ field: 'block_height', op: 'gte', value: '8000000' });
  });

  test('"from" address → initiator_account_hash', () => {
    const r = parseNaturalLanguage('transfers from b383c7cc23d18bc1b42406a1b2d29fc8dba86425197b6f553d7fd61375b5e446');
    expect(r.predicate!.and).toContainEqual({
      field: 'initiator_account_hash',
      op: 'eq',
      value: 'b383c7cc23d18bc1b42406a1b2d29fc8dba86425197b6f553d7fd61375b5e446',
    });
  });

  test('unrecognised prompt returns null', () => {
    const r = parseNaturalLanguage('the cat sat on the mat');
    expect(r.predicate).toBeNull();
    expect(r.understood).toEqual([]);
  });

  test('motes unit suppresses CSPR conversion', () => {
    const r = parseNaturalLanguage('over 5000000000 motes');
    expect(r.predicate!.and[0].value).toBe('5000000000');
  });
});
