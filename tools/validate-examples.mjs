#!/usr/bin/env node
/**
 * Validates every file in examples/ against schema/v2.json, and, more
 * importantly, recomputes the integrity block from the payload rather than
 * trusting the hashes that are written in the file.
 *
 * Shape validation alone is close to worthless for this spec. A record can
 * satisfy every constraint in the JSON Schema (all fields present, every hash
 * matching ^sha256:[a-f0-9]{64}$) while carrying hashes that do not correspond
 * to its own payload. That is exactly the failure that matters here: the
 * examples are what implementers copy, so a wrong hash in this directory
 * propagates into every downstream implementation as a "correct" reference.
 *
 * So this recomputes, per SPEC.md 3.4:
 *
 *   payload_hash   = "sha256:" + hex(sha256(JCS(payload)))
 *   chain_input    = payload_hash + (parent_hash ?? "root")
 *   integrity_hash = "sha256:" + hex(sha256(chain_input))
 *
 * and for array examples, walks the chain checking that each parent_hash is
 * the previous record's integrity_hash.
 *
 * Run: node tools/validate-examples.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const schema = JSON.parse(readFileSync(join(root, 'schema/v2.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let failures = 0;
const fail = (file, msg) => { failures++; console.error(`  FAIL  ${file}: ${msg}`); };

function checkRecord(file, rec, label) {
  const where = label ? `${file} [${label}]` : file;

  if (!validate(rec)) {
    for (const e of validate.errors) fail(where, `schema: ${e.instancePath || '/'} ${e.message}`);
    return null;
  }

  // Recompute payload_hash from the payload itself.
  const expectedPayload = 'sha256:' + sha256(canonicalize(rec.payload));
  if (rec.integrity.payload_hash !== expectedPayload) {
    fail(where, `payload_hash does not match payload\n          stored:   ${rec.integrity.payload_hash}\n          computed: ${expectedPayload}`);
  }

  // Recompute integrity_hash. Root records chain against the literal "root".
  const parentHash = rec.integrity.parent_hash;
  const chainInput = expectedPayload + (parentHash ?? 'root');
  const expectedIntegrity = 'sha256:' + sha256(chainInput);
  if (rec.integrity.integrity_hash !== expectedIntegrity) {
    fail(where, `integrity_hash does not match payload_hash + ${parentHash ? 'parent_hash' : '"root"'}\n          stored:   ${rec.integrity.integrity_hash}\n          computed: ${expectedIntegrity}`);
  }

  // A root record must not claim a parent, and vice versa.
  if (rec.parent_id === null && parentHash !== null) {
    fail(where, 'parent_id is null but parent_hash is set');
  }
  if (rec.parent_id !== null && parentHash === null) {
    fail(where, `parent_id is ${rec.parent_id} but parent_hash is null`);
  }

  return rec;
}

const files = readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('  FAIL  examples/ contains no .json files');
  process.exit(1);
}

console.log(`\n  Context Passport, validating ${files.length} example file(s) against schema/v2.json\n`);

for (const f of files) {
  const raw = JSON.parse(readFileSync(join(root, 'examples', f), 'utf8'));

  if (Array.isArray(raw)) {
    let prev = null;
    raw.forEach((rec, i) => {
      const ok = checkRecord(f, rec, `${i}`);
      if (ok && prev) {
        // Chain linkage: this record's parent_hash must be the previous
        // record's integrity_hash, and parent_id must name the previous id.
        if (ok.integrity.parent_hash !== prev.integrity.integrity_hash) {
          fail(f, `[${i}] parent_hash is not [${i - 1}].integrity_hash`);
        }
        if (ok.parent_id !== prev.id) {
          fail(f, `[${i}] parent_id "${ok.parent_id}" is not [${i - 1}].id "${prev.id}"`);
        }
      }
      prev = ok ?? prev;
    });
    console.log(`  checked  ${f}  (chain of ${raw.length})`);
  } else {
    checkRecord(f, raw, null);
    console.log(`  checked  ${f}`);
  }
}

if (failures) {
  console.error(`\n  ${failures} problem(s) found.\n`);
  process.exit(1);
}
console.log('\n  All examples valid: schema, recomputed hashes, and chain linkage.\n');
