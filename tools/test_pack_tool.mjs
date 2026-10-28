// Tests for the food pack build tool. Run from the project root: node tools/test_pack_tool.mjs
import assert from 'node:assert/strict';

const { parseNutritionixMenu, servingLabel, cleanName, cellValue, splitSkip, sectionSkipped } = await import('./build_pack.mjs');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

// Inline fixture shaped like nutritionix.com/<slug>/menu/premium. The columns are deliberately not in the
// real page's order, so the test proves the parser reads the order from the <thead> sort links.
const th = (key) => `<th><a class="rel down sort-link" href="/x/menu/premium?sort=${key}"><span>${key}</span></a></th>`;
const COLS = ['protein', 'calories', 'sodium', 'total_fat', 'fibers', 'total_carb'];
const row = (idAttr, name, vals) =>
  `<tr class="odd"><td class="al" headers="inmGrid_c0"><a class="nmItem" title="${name.replace(/<[^>]*>/g, '')}" id="${idAttr}" href="viewLabel">${name}</a>` +
  `<a class="moreInfo fr" id="x1-item-0-notFromAllergenPage" href="viewLabel">[more info]</a></td>` +
  COLS.map((k) => `<td class="col" headers="c">${vals[k] ?? ''}</td>`).join('') + '</tr>';
const sub = (name) => `<tr class="subCategory"><td colspan="7"><h3>${name}</h3><p></p></td></tr>`;

const FIXTURE = `<html><body><table class="tblCompare">
<thead><tr><th class="first"><a class="sort-link" href="/x/menu/premium?sort=name"></a></th>${COLS.map(th).join('')}</tr></thead>
<tbody>
${row('z1-item-100-notFromAllergenPage', 'Orphan Item', { calories: 10, protein: 1, total_carb: 2, total_fat: 0, fibers: 0 })}
${sub('Burritos')}
${row('z925794-item-166727-notFromAllergenPage', 'Burrito Supreme&reg; - Beef', { calories: 390, protein: 16, total_carb: 52, total_fat: 14, fibers: 8, sodium: '1,160' })}
${row('z2-item-200-notFromAllergenPage', 'Big <b>Box</b>   Meal', { calories: '1,230', protein: 40, total_carb: 150, total_fat: 50, fibers: '<span class="less-than">&lt;</span>1' })}
${row('z3-item-300-notFromAllergenPage', 'No Calories Here', { calories: '', protein: 1 })}
${sub('Cantina Beer, Wine and Spirits')}
${row('z8-item-700-notFromAllergenPage', 'Lager (12 oz)', { calories: 150, total_carb: 13 })}
${row('z9-item-800-notFromAllergenPage', 'House Margarita', { calories: 280, total_carb: 40 })}
${sub('Drinks &amp; More')}
${row('z5-item-166727-notFromAllergenPage', 'Burrito Supreme - Beef again', { calories: 999 })}
${row('z6-item-500-notFromAllergenPage', 'Taj&iacute;n&reg;Freeze&trade; (16 oz)', { calories: 160, total_carb: 40 })}
${row('z7-item-600-notFromAllergenPage', 'Lemonade', { calories: 120, total_carb: 30 })}
${row('z10-item-800-notFromAllergenPage', 'House Margarita (Drinks copy)', { calories: 281, total_carb: 41 })}
${sub('Fountain Beverages (16 oz)')}
${row('z11-ingredient-100-notFromAllergenPage', 'Diet Pepsi&reg; (16 fl oz)', { calories: 0, protein: 0, total_carb: 0 })}
${row('z12-ingredient-33441-notFromAllergenPage', 'Brisk&reg; Mango Iced Tea', { calories: 90, total_carb: 24 })}
${row('z13-ingredient-33441-notFromAllergenPage', 'Brisk Mango Iced Tea duplicate', { calories: 91 })}
</tbody></table></body></html>`;

const parsed = parseNutritionixMenu(FIXTURE);
const byId = Object.fromEntries(parsed.foods.map((f) => [f.id, f]));

test('parse: item and ingredient rows, duplicates and rows without calories skipped', () => {
  assert.deepEqual(parsed.foods.map((f) => f.id),
    ['100', '166727', '200', '700', '800', '500', '600', 'i100', 'i33441']);
});
test('parse: fountain-drink (-ingredient-) rows become foods with id "i<id>"', () => {
  assert.deepEqual(byId.i100, { id: 'i100', n: 'Diet Pepsi (16 fl oz)', cat: 'Fountain Beverages (16 oz)', s: ['1 drink (16 oz)', null], v: [0, 0, 0, 0, 0] });
  assert.deepEqual(byId.i33441, { id: 'i33441', n: 'Brisk Mango Iced Tea', cat: 'Fountain Beverages (16 oz)', s: ['1 drink (16 oz)', null], v: [90, 0, 24, 0, 0] });
  assert.equal(byId['100'].n, 'Orphan Item', 'item 100 and ingredient 100 do not collide');
});
test('parse: --skip drops sections (case-insensitive, names with commas work in a comma list)', () => {
  const p = parseNutritionixMenu(FIXTURE, { skip: splitSkip('cantina BEER, Wine and Spirits,burritos') });
  assert.deepEqual(p.foods.map((f) => f.id), ['100', '166727', '500', '600', '800', 'i100', 'i33441']);
  // Rows in a skipped section do not claim their id: the later copy in a kept section is used.
  assert.equal(p.foods.find((f) => f.id === '166727').n, 'Burrito Supreme - Beef again');
  assert.equal(p.foods.find((f) => f.id === '800').cat, 'Drinks & More');
  assert.deepEqual(p.sections.filter((s) => s.skipped).map((s) => s.name), ['Burritos', 'Cantina Beer, Wine and Spirits']);
  assert.equal(p.sections.find((s) => s.name === 'Burritos').count, 0);
});
test('sectionSkipped: exact names only', () => {
  assert.equal(sectionSkipped('Cantina Beer, Wine and Spirits', splitSkip('Cantina Beer, Wine and Spirits')), true);
  assert.equal(sectionSkipped('Cantina Beer, Wine and Spirits', splitSkip('Cantina Beer')), false);
  assert.equal(sectionSkipped('Cantina Menu', splitSkip('cantina')), false);
  assert.equal(sectionSkipped('Drinks', splitSkip('Tacos, drinks')), true);
  assert.equal(sectionSkipped('Drinks', []), false);
});
test('parse: columns mapped from thead order, v = [kcal, protein, carbs, fat, fiber]', () => {
  assert.deepEqual(byId['166727'].v, [390, 16, 52, 14, 8]);
});
test('parse: comma values and "<1" cells', () => {
  assert.deepEqual(byId['200'].v, [1230, 40, 150, 50, 0.5]);
});
test('parse: blank cells are 0', () => {
  assert.deepEqual(byId['600'].v, [120, 0, 30, 0, 0]);
});
test('parse: subCategory rows set cat; rows before any section have no cat', () => {
  assert.equal(byId['166727'].cat, 'Burritos');
  assert.equal(byId['200'].cat, 'Burritos');
  assert.equal(byId['500'].cat, 'Drinks & More');
  assert.equal('cat' in byId['100'], false);
});
test('parse: first occurrence of a duplicate id wins', () => {
  assert.equal(byId['166727'].n, 'Burrito Supreme - Beef');
});
test('parse: names cleaned (tags, entities, marks, whitespace)', () => {
  assert.equal(byId['200'].n, 'Big Box Meal');
  assert.equal(byId['500'].n, 'Tajín Freeze (16 oz)');
  for (const f of parsed.foods) assert.ok(!/[®™\uFFFD<>&]/u.test(f.n), f.n);
});
test('parse: serving labels with null grams', () => {
  assert.deepEqual(byId['166727'].s, ['1 burrito', null]);
  assert.deepEqual(byId['500'].s, ['1 drink (16 oz)', null]);
  assert.deepEqual(byId['600'].s, ['1 drink', null]);
  assert.deepEqual(byId['100'].s, ['1 serving', null]);
});
test('parse: sections list with kept-item counts', () => {
  assert.deepEqual(parsed.sections, [
    { name: 'Burritos', count: 2 }, { name: 'Cantina Beer, Wine and Spirits', count: 2 },
    { name: 'Drinks & More', count: 2 }, { name: 'Fountain Beverages (16 oz)', count: 2 }
  ]);
});
test('parse: missing thead or needed column throws', () => {
  assert.throws(() => parseNutritionixMenu('<table><tbody></tbody></table>'), /thead/);
  assert.throws(() => parseNutritionixMenu(`<thead><tr>${th('calories')}${th('protein')}</tr></thead>`), /total_carb/);
});

test('servingLabel heuristic, first hit wins', () => {
  assert.equal(servingLabel('Crunchy Taco', 'Tacos'), '1 taco');
  assert.equal(servingLabel('Chalupa Supreme', 'Tacos'), '1 taco');
  assert.equal(servingLabel('Bean Burrito', 'Burritos'), '1 burrito');
  assert.equal(servingLabel('Cheese Quesadilla', 'Quesadillas'), '1 quesadilla');
  assert.equal(servingLabel('Cantina Chicken Bowl', 'Cantina Chicken Menu'), '1 bowl');
  assert.equal(servingLabel('Nachos BellGrande', 'Nachos'), '1 order');
  assert.equal(servingLabel('Nacho Fries', 'Sides'), '1 order');
  assert.equal(servingLabel('Chips and Guacamole', 'Sides'), '1 order');
  assert.equal(servingLabel('Baja Blast (20 oz)', 'New'), '1 drink (20 oz)');
  assert.equal(servingLabel('Brisk Mango Iced Tea (16 fl oz)', 'Drinks'), '1 drink (16 oz)');
  assert.equal(servingLabel('Pepsi', 'Fountain Beverages (30 oz)'), '1 drink (30 oz)');
  assert.equal(servingLabel('Orange Juice', 'Drinks'), '1 drink');
  assert.equal(servingLabel('Mexican Mocha', 'Hot Coffee'), '1 drink');
  assert.equal(servingLabel('Crispy Chicken Nuggets - 5 Piece', 'New'), '1 order');
  assert.equal(servingLabel('Wings 6 pc', 'Specials'), '1 order');
  assert.equal(servingLabel('Cinnamon Twists', 'Sides & Sweets'), '1 serving');
  assert.equal(servingLabel('Taco Bell Diablo Sauce Packet', 'Sauces'), '1 serving');
});

test('cleanName and cellValue helpers', () => {
  assert.equal(cleanName('Crunchy Taco Supreme&reg;'), 'Crunchy Taco Supreme');
  assert.equal(cleanName('Cheesy Bean &amp; Rice Burrito (V)'), 'Cheesy Bean & Rice Burrito (V)');
  assert.equal(cleanName('Bad\uFFFD Byte  Name '), 'Bad Byte Name');
  assert.equal(cellValue('1,160'), 1160);
  assert.equal(cellValue('<span class="less-than">&lt;</span>1'), 0.5);
  assert.equal(cellValue('  '), 0);
  assert.equal(cellValue('n/a'), null);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
