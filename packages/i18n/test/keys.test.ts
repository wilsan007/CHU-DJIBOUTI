import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function load(lang: string): Record<string, string> {
  const url = new URL(`../src/${lang}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, string>;
}

const fr = load("fr");
const ar = load("ar");

test("le français et l'arabe ont exactement les mêmes clés", () => {
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(ar).sort());
});

test("aucune traduction vide", () => {
  for (const [lang, dict] of [
    ["fr", fr],
    ["ar", ar],
  ] as const) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(value.trim() !== "", `${lang}:${key} est vide`);
    }
  }
});

test("les textes arabes contiennent bien des caractères arabes", () => {
  // Le bouton de langue montre le nom de l'autre langue, dans cette langue : « Français » en arabe.
  const exceptions = new Set(["nav.language"]);
  for (const [key, value] of Object.entries(ar)) {
    if (exceptions.has(key)) continue;
    assert.match(value, /[؀-ۿ]/, `ar:${key} n'est pas en arabe`);
  }
});
