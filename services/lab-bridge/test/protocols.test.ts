import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACK,
  astmReceiver,
  astmToInternal,
  buildFrame,
  checksum,
  ENQ,
  EOT,
  NAK,
  toText,
} from "../src/astm.ts";
import { controlId, hl7Ack, mllpReceiver, mllpWrap, oruToInternal } from "../src/hl7.ts";

const RECORDS = [
  "H|\\^&|||Analyseur^1.0",
  "P|1",
  "O|1|S-000123X||^^^GLU",
  "R|1|^^^GLU|5.2|mmol/L|3.9-6.1|N||F",
  "R|2|^^^CHOL|4.1|mmol/L|||| P",
  "L|1|N",
];

test("ASTM : somme de contrôle conforme à E1381 (exemple calculé à la main)", () => {
  // « 1H|\^&\r\x03 » : 0x31+0x48+0x7C+0x5C+0x5E+0x26+0x0D+0x03 = 0x1E5 → E5
  assert.equal(checksum(Buffer.from("1H|\\^&\r\x03", "latin1")), "E5");
  const frame = buildFrame(1, "H|\\^&\r");
  assert.equal(frame.subarray(-4, -2).toString(), "E5");
});

test("ASTM : poignée de main, trames, EOT ; résultat final accepté, préliminaire écarté", () => {
  const rx = astmReceiver();
  const out = [
    rx.push(Buffer.from([ENQ])),
    rx.push(buildFrame(1, RECORDS.join("\r") + "\r")),
    rx.push(Buffer.from([EOT])),
  ];
  assert.deepEqual(out[0]!.replies, [Buffer.from([ACK])]);
  assert.deepEqual(out[1]!.replies, [Buffer.from([ACK])]);
  const message = out[1]!.messages[0] ?? out[2]!.messages[0];
  assert.ok(message, "message complet rendu dès l'enregistrement L");
  const [m] = astmToInternal(message, "SIM1");
  assert.equal(m!.specimenScan, "S-000123X");
  assert.deepEqual(m!.results, [{ code: "GLU", value: "5.2", unit: "mmol/L" }]);
  assert.deepEqual(m!.skipped, ["CHOL (statut P)"]);
  assert.equal(toText(m!), "H|SIM1\nO|S-000123X\nR|GLU|5.2|mmol/L");
});

test("ASTM : somme fausse → NAK, renvoi accepté ; doublon acquitté sans être compté deux fois", () => {
  const rx = astmReceiver();
  rx.push(Buffer.from([ENQ]));
  const frame = buildFrame(1, RECORDS.join("\r") + "\r");
  const bad = Buffer.from(frame);
  bad[bad.length - 4] = bad[bad.length - 4]! ^ 1;
  assert.deepEqual(rx.push(bad).replies, [Buffer.from([NAK])]);
  const good = rx.push(frame);
  assert.deepEqual(good.replies, [Buffer.from([ACK])]);
  assert.equal(good.messages.length, 1);
  const dup = rx.push(frame); // notre ACK s'est perdu, l'automate renvoie
  assert.deepEqual(dup.replies, [Buffer.from([ACK])]);
  assert.equal(dup.messages.length, 0, "pas de second message");
});

test("ASTM : trames coupées en morceaux et message sur plusieurs trames (ETB)", () => {
  const rx = astmReceiver();
  const text = RECORDS.join("\r") + "\r";
  const f1 = buildFrame(1, text.slice(0, 40), false);
  const f2 = buildFrame(2, text.slice(40), true);
  rx.push(Buffer.from([ENQ]));
  const all = Buffer.concat([f1, f2]);
  const messages = [];
  for (let i = 0; i < all.length; i += 7)
    messages.push(...rx.push(all.subarray(i, i + 7)).messages);
  assert.equal(messages.length, 1);
  assert.equal(astmToInternal(messages[0]!, "A")[0]!.results.length, 1);
  // Trame hors séquence : refusée.
  const rx2 = astmReceiver();
  rx2.push(Buffer.from([ENQ]));
  assert.deepEqual(rx2.push(buildFrame(3, "L|1\r")).replies, [Buffer.from([NAK])]);
});

test("ASTM : deux échantillons dans un message ; identifiant lu dans le champ 3 à défaut du 2", () => {
  const msg = [
    ["H"],
    ["O", "1", "S-1^pos", "", "^^^GLU"],
    ["R", "1", "^^^GLU", "5", "mmol/L"],
    ["O", "2", "", "S-2"],
    ["R", "1", "^^^GLU", "6", "mmol/L"],
    ["L", "1"],
  ];
  const out = astmToInternal(msg, "A");
  assert.deepEqual(
    out.map((m) => m.specimenScan),
    ["S-1", "S-2"],
  );
});

const ORU = [
  "MSH|^~\\&|ANALYSEUR|LABO|CHU-LIS|CHU|20261103120000||ORU^R01|MSG0042|P|2.5",
  "PID|1",
  "OBR|1|PLACER1|S-000123X|GLU^Glycémie",
  "OBX|1|NM|GLU^Glucose^L||5.2|mmol/L^mmol/L|3.9-6.1|N|||F",
  "OBX|2|NM|CHOL^Cholestérol^L||4.1|mmol/L|||||P",
].join("\r");

test("HL7 v2 / MLLP : ORU^R01 lu, accusé AA avec le bon identifiant, résultat préliminaire écarté", () => {
  const rx = mllpReceiver();
  const half = mllpWrap(ORU);
  assert.deepEqual(rx.push(half.subarray(0, 30)), []);
  const msgs = rx.push(half.subarray(30));
  assert.equal(msgs.length, 1);
  const [m] = oruToInternal(msgs[0]!, "SIM2");
  assert.equal(m!.specimenScan, "S-000123X");
  assert.deepEqual(m!.results, [{ code: "GLU", value: "5.2", unit: "mmol/L" }]);
  assert.deepEqual(m!.skipped, ["CHOL (statut P)"]);
  const ack = hl7Ack(ORU, "AA");
  assert.match(ack, /MSA\|AA\|MSG0042/);
  assert.equal(controlId(ORU), "MSG0042");
  assert.throws(
    () => oruToInternal("MSH|^~\\&|A|B|C|D|t||ADT^A01|1|P|2.5", "X"),
    /non pris en charge/,
  );
  assert.throws(() => oruToInternal("n'importe quoi", "X"), /MSH/);
});
