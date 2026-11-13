import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindAttribution,
  decisionEligible,
  attributionLabel,
  contradicts,
} from '../src/memory/attribution.js';

test('first-hand preference is decision-eligible', () => {
  const a = bindAttribution({
    type: 'preference',
    subject: 'user:jincheng',
    speaker: 'user:jincheng',
    hop: 0,
  });
  assert.equal(a.type, 'preference');
  assert.equal(a.downgraded, false);
  assert.equal(decisionEligible({ type: a.type, hop: a.hop, subject: a.subject }), true);
});

test('second-hand preference is demoted to hearsay and never decision-eligible', () => {
  const a = bindAttribution({
    type: 'preference',
    subject: 'user:someone-else',
    speaker: 'agent:mallory',
    hop: 1,
  });
  assert.equal(a.type, 'hearsay');
  assert.equal(a.downgraded, true);
  assert.equal(decisionEligible({ type: a.type, hop: a.hop, subject: a.subject }), false);
  assert.ok(a.notes.some((n) => n.includes('hearsay')));
});

test('hop is clamped to a non-negative integer', () => {
  assert.equal(bindAttribution({ hop: -3 }).hop, 0);
  assert.equal(bindAttribution({ hop: 2.7 }).hop, 2);
});

test('a preference with no subject is recorded but flagged', () => {
  const a = bindAttribution({ type: 'preference', hop: 0 });
  assert.equal(a.subject, null);
  assert.ok(a.notes.some((n) => n.includes('without a subject')));
  // An unattributed preference has no defensible owner, so it cannot steer behaviour.
  assert.equal(decisionEligible({ type: a.type, hop: a.hop, subject: a.subject }), false);
});

test('role grounding attack: a quoted "user:" line cannot become my user preference', () => {
  // The attacker's post honestly says: my user wants tool X. The victim paraphrase
  // arrives at hop=1. Even if someone labels it `preference`, binding must demote it.
  const incoming = bindAttribution({
    type: 'preference',
    subject: 'user:mallory',
    speaker: 'agent:mallory',
    addressee: 'agent:self',
    hop: 1,
  });

  assert.equal(incoming.type, 'hearsay');
  assert.equal(incoming.subject, 'user:mallory', 'subject must stay the attacker user');
  assert.equal(decisionEligible({ type: incoming.type, hop: incoming.hop, subject: incoming.subject }), false);
});

test('labels distinguish first-hand from relayed', () => {
  assert.equal(attributionLabel({ hop: 0, type: 'fact', subject: null, speaker: null }), 'first-hand');
  const relayed = attributionLabel({
    hop: 2,
    type: 'hearsay',
    subject: 'user:a',
    speaker: 'agent:b',
  });
  assert.ok(relayed.includes('relayed x2'));
  assert.ok(relayed.includes('not decision-eligible'));
});

test('contradicts detects opposite polarity about the same subject', () => {
  const a = { subject: 'user:jincheng', abstract: '金呈喜欢详细解释' };
  const b = { subject: 'user:jincheng', abstract: '金呈不喜欢详细解释' };
  assert.equal(contradicts(a, b), true);
  assert.equal(contradicts(a, a), false);
});

test('contradicts ignores claims about different subjects', () => {
  const a = { subject: 'user:a', abstract: '喜欢详细解释' };
  const b = { subject: 'user:b', abstract: '不喜欢详细解释' };
  assert.equal(contradicts(a, b), false);
});
