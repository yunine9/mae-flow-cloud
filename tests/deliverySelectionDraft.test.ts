import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeliverySelectionDraft } from '../web/src/deliverySelectionDraft.ts';

test('file selection survives reload of the same card but cannot leak into another task/card', () => {
 const draft = {key:'task-1/card-1',selection:{selectedPaths:['a.cpp'],committedPaths:['a.cpp','b.cpp'],allPaths:['a.cpp','b.cpp']}};
 assert.deepEqual(readDeliverySelectionDraft(JSON.stringify(draft),draft.key),draft);
 assert.equal(readDeliverySelectionDraft(JSON.stringify(draft),'task-2/card-1'),undefined);
 assert.equal(readDeliverySelectionDraft(JSON.stringify(draft),'task-1/card-2'),undefined);
 assert.equal(readDeliverySelectionDraft('{broken',draft.key),undefined);
 assert.equal(readDeliverySelectionDraft(JSON.stringify({key:draft.key,selection:{selectedPaths:'all'}}),draft.key),undefined);
});
