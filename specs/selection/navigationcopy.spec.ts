import { test } from '../../fixtures.ts';

test('distractor sibling must never be selected by the bounded target', async () => {
  throw new Error('Explicit selection incorrectly included a sibling spec');
});
