import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ICP_MADRID_URL,
  PROCEDURES,
  PUBLIC_PROCEDURE_KEYS,
  procedureMatches
} from '../lib/procedures.js';

test('the worker starts on the direct Madrid appointment page', () => {
  assert.equal(
    ICP_MADRID_URL,
    'https://icp.administracionelectronica.gob.es/icpplustiem/citar?p=28&locale=es'
  );
});

test('all public procedures match their official portal name and no other public procedure', () => {
  assert.equal(PUBLIC_PROCEDURE_KEYS.length, 14);

  for (const key of PUBLIC_PROCEDURE_KEYS) {
    const definition = PROCEDURES[key];
    assert.ok(definition, `missing definition for ${key}`);
    assert.ok(procedureMatches(key, definition.official), `${key} does not match its official name`);

    const matches = PUBLIC_PROCEDURE_KEYS.filter((candidate) => (
      procedureMatches(candidate, definition.official)
    ));
    assert.deepEqual(matches, [key], `${key} is ambiguous: ${matches.join(', ')}`);
  }
});

test('the interface exposes every public procedure exactly once', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const interfaceKeys = [...html.matchAll(/class="choice"\s+data-key="([^"]+)"/g)]
    .map((match) => match[1]);

  assert.equal(new Set(interfaceKeys).size, interfaceKeys.length, 'the interface contains duplicate procedure keys');
  assert.deepEqual([...interfaceKeys].sort(), [...PUBLIC_PROCEDURE_KEYS].sort());
  for (const key of PUBLIC_PROCEDURE_KEYS) {
    assert.ok(html.includes(PROCEDURES[key].official), `the confirmation text is missing for ${key}`);
  }
});
