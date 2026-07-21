import { looksSyntheticOwner } from '../src/index';

describe('looksSyntheticOwner — by-construction demo detection', () => {
  // Genuine testnet account hashes (high-entropy blake2b digests). These are the
  // real owners on the live registry (subs 1 and 3) plus the matcher key.
  const realOwners = [
    'ecf442b39a406ad04ee09cdf016d3a0659423d8054866b6fd4532696e46d7309',
    '0141ae56d7afef7eb22298b50db5f013cd6945a26eab4098eebd97e9cf6064f6',
    '65bedddde009284db1bd62614afc8bbeb405590ddec1669eca3db38b5e18810f',
  ];

  // Hand-typed placeholder owners used by injected demo/synthetic lanes. A real
  // blake2b digest can never look like this (long uniform runs / low entropy).
  const syntheticOwners = [
    'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888', // live sub 4 + demo lanes 101/102/103
    'aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb9999', // live sub 5
    '0000000000000000000000000000000000000000000000000000000000000000',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ];

  it.each(realOwners)('treats a genuine account hash as real: %s', (owner) => {
    expect(looksSyntheticOwner(owner)).toBe(false);
  });

  it.each(syntheticOwners)('flags a synthetic placeholder owner as demo: %s', (owner) => {
    expect(looksSyntheticOwner(owner)).toBe(true);
  });

  it('flags malformed owners (wrong length, non-hex, empty) as demo', () => {
    for (const bad of ['', 'deadbeef', 'ECF442B39A406AD04EE09CDF016D3A0659423D8054866B6FD4532696E46D7309zz', 'not-a-hash']) {
      expect(looksSyntheticOwner(bad)).toBe(true);
    }
    // Uppercase is normalised, so a genuine hash in caps is still real.
    expect(looksSyntheticOwner('ECF442B39A406AD04EE09CDF016D3A0659423D8054866B6FD4532696E46D7309')).toBe(false);
  });
});
