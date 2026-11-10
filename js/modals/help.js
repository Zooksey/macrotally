// MacroTally — "How to use the app": plain-language help topics listed at the top of the Settings tab. Each row
// (data-action="open-help" data-topic="<id>") opens one topic in a bottom sheet. A few lines depend on state
// (meal names, units, whether the AI helper and Google Drive backup are set up) so the text matches the app.
import { state } from '../store.js';
import { esc, on, openModal } from '../ui.js';
import { aiConfigured } from '../ai.js';
import { driveConfigured } from '../drive.js';
import { sheetHead } from './settings.js';

const README = 'https://github.com/Zooksey/macrotally#readme';
const readmeLink = (text) => `<a href="${README}" target="_blank" rel="noopener">${esc(text)}</a>`;

function meals() {
  return state.meals && state.meals.length ? state.meals : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
}

const metric = () => state.profile && state.profile.units === 'metric';
const wUnit = () => (metric() ? 'kg' : 'lb');

function startBody() {
  return `
    <p>MacroTally tracks what you eat and what you weigh, and works out how many calories you really burn. There is no account: everything stays on this phone.</p>
    <h3>Setup</h3>
    <p>The setup wizard runs the first time you open the app. It asks for your units, sex, birth year, height, current weight, activity and goal, then sets a starting calorie estimate from a standard formula when you tap <strong>Get started</strong>. To change your answers later, go to <strong>Settings</strong> → <strong>Profile</strong> → <strong>Run setup again</strong>.</p>
    <h3>Install it</h3>
    <ul>
      <li><strong>iPhone:</strong> open the link in Safari, tap Share, then <strong>Add to Home Screen</strong>, and always open it from that icon. iPhones can wipe the data of a web page that is not on the home screen and goes unused for a week.</li>
      <li><strong>Android:</strong> in Chrome, tap <strong>Install</strong> or menu → <strong>Add to Home screen</strong>.</li>
    </ul>
    <p>Until it is installed, <strong>Settings</strong> also shows an <strong>Install</strong> row with these steps.</p>
    <h3>The first week</h3>
    <ol>
      <li>Log everything you eat on the <strong>Diary</strong> tab, every day.</li>
      <li>Weigh yourself most mornings and log it.</li>
      <li>Watch the trend weight on the <strong>Weight</strong> tab, not the daily number.</li>
    </ol>
    <p>After about a week of this, the <strong>Plan</strong> tab starts adjusting your calorie target to what your body actually does.</p>`;
}

function loggingBody() {
  const list = meals();
  const first = esc(list[0]);
  return `
    <p>The <strong>Diary</strong> tab shows one day: calories and macros eaten against your targets, then your meals (${esc(list.join(', '))}). Use the arrows at the top to change the day, and <strong>Today</strong> to jump back.</p>
    <h3>Add a food</h3>
    <ol>
      <li>Tap <strong>Add food</strong> under a meal.</li>
      <li>Type at least two letters in the search box. Foods you have used and the built-in list show at once; online results follow when you stop typing. Each result shows the calories for the food's serving, or per 100 g.</li>
      <li>Or pick from the <strong>Recent</strong>, <strong>Favorites</strong> and <strong>My foods</strong> tabs below the search box.</li>
      <li>Tap a food, set the amount in servings, grams or ounces, and watch the numbers update.</li>
      <li>Tap <strong>Add to ${first}</strong> (the button names whichever meal is picked under <strong>Meal</strong>).</li>
    </ol>
    <p>Tap the ★ at the top of a food to make it a favorite.</p>
    <h3>Change or delete an entry</h3>
    <p>Tap an entry in the diary. Change the amount, unit or meal and tap <strong>Save changes</strong>, or tap <strong>Delete</strong>.</p>
    <h3>Meals</h3>
    <p>Rename, add or remove meals in <strong>Settings</strong> → <strong>Meals</strong>.</p>`;
}

function scanningBody() {
  return `
    <p>Scanning is the fastest way to log packaged food.</p>
    <h3>Scan</h3>
    <ol>
      <li>Tap <strong>Add food</strong> under a meal, then <strong>Scan barcode</strong>.</li>
      <li>Allow the camera when asked, and hold the barcode inside the frame.</li>
      <li>The food opens with its numbers. Set the amount and add it as usual.</li>
    </ol>
    <p>The app checks your own foods first, then Open Food Facts and USDA, so a food you have fixed is always found with your numbers.</p>
    <h3>No camera prompts: Add via photo(s)</h3>
    <p>If your phone asks for camera permission every time you scan, tap <strong>Add via photo(s)</strong> instead. It uses your phone's own camera app, so it never asks. Tap <strong>Take photo</strong>, snap the barcode and tap <strong>Find food</strong>; the barcode is read from the photo and looked up as usual. With the AI helper set up, also snap the Nutrition Facts panel and the front label, and Claude reads the food from them when the barcode isn't found.</p>
    <h3>When the camera doesn't work</h3>
    <p>Type the numbers under the barcode into <strong>Or type the barcode</strong> and tap <strong>Look up</strong>. Typing a barcode into the search box works too. The camera needs a secure (https) page; if <strong>Scan barcode</strong> is greyed out, use typing instead.</p>
    <h3>Food not found</h3>
    <p>The app asks whether to create it. Tap <strong>Create food</strong>, copy the numbers from the label and tap <strong>Save food</strong>. The barcode is filled in for you, so the next scan finds it straight away.</p>
    <h3>Numbers look wrong?</h3>
    <p>Open data is not always right. Tap <strong>Edit food</strong> on the food to correct it (see <strong>Custom foods and fixing numbers</strong>).</p>`;
}

function aiBody() {
  const ready = aiConfigured(state);
  const setup = ready
    ? `<p>The AI helper is set up on this phone. To set up another phone, open <strong>Settings</strong> → <strong>AI helper</strong> and tap <strong>Copy secret</strong> (or <strong>Share secret…</strong>, where your phone offers it).</p>`
    : `<p>The AI helper is not set up on this phone yet. Get the secret from whoever runs it, then go to <strong>Settings</strong> → <strong>AI helper</strong>, paste it into <strong>Secret</strong> and tap <strong>Save AI helper</strong>. The helper address is built in, so only the secret is needed. Once it is saved, <strong>Test</strong> checks the connection.</p>`;
  return `
    <p><strong>AI add</strong> lets Claude work out what you ate from a description, photos, or both. You check the result before anything is logged.</p>
    <h3>Setup</h3>
    ${setup}
    <h3>Ask</h3>
    <ol>
      <li>Tap <strong>Add food</strong> under a meal, then <strong>AI add</strong>.</li>
      <li>Describe the food (for example "71 g of Dot's pretzels"), and/or tap <strong>Take photo</strong> or <strong>Choose photo</strong>: up to 4, such as the pack front and its Nutrition Facts panel.</li>
      <li>Tap <strong>Ask Claude</strong> and wait 20 to 40 seconds.</li>
    </ol>
    <h3>Check the answer</h3>
    <p>Each food gets a card showing where the numbers came from (<strong>Label</strong>, <strong>Web</strong> or <strong>Estimate</strong>). If the food is already in your foods, that one is used. If the numbers differ, pick <strong>Use stored</strong> or Claude's numbers (<strong>Update stored</strong> for your own foods, <strong>Add corrected copy</strong> for others). Adjust the amount, fix anything with <strong>Edit details</strong>, untick what you don't want, and tap the add button (for example <strong>Add 2 to ${esc(meals()[0])}</strong>). Wrong? Type under <strong>Not right? Tell Claude</strong> and tap <strong>Ask again</strong>.</p>
    <h3>Packaged food: Add via photo(s)</h3>
    <p>For something in a pack, <strong>Add via photo(s)</strong> (under <strong>Scan barcode</strong>) is often quicker: snap the barcode, the Nutrition Facts panel and the front label, and tap <strong>Find food</strong>. A barcode already in your foods opens straight away. Otherwise the barcode is looked up, or Claude reads the label, and the barcode is saved with Claude's food so the next scan finds it.</p>
    <h3>Recipes</h3>
    <p>Paste a recipe and ask for one entry per slice or serving. You get one food for the dish, per slice or serving.</p>
    <p class="muted">What you type and photograph goes to the helper and on to Claude; nothing else is sent. To run your own helper, see the ${readmeLink('README')}.</p>`;
}

function fixingBody() {
  const label = aiConfigured(state)
    ? '<p>Tap <strong>Read the nutrition label</strong> in the food form and photograph the Nutrition Facts panel. Claude fills in the numbers for you to check before you tap <strong>Save food</strong>.</p>'
    : '<p>With the AI helper set up (<strong>Settings</strong> → <strong>AI helper</strong>), the food form gets a <strong>Read the nutrition label</strong> button: photograph the Nutrition Facts panel and Claude fills in the numbers for you to check.</p>';
  return `
    <p>You can add your own foods and correct any food, including scanned ones, built-in foods and restaurant items.</p>
    <h3>Create a food</h3>
    <ol>
      <li>Tap <strong>Add food</strong> under a meal, then <strong>Create custom food</strong> at the bottom.</li>
      <li>Enter the name and, if you like, the brand and barcode.</li>
      <li>Enter the serving label and its size in grams. Leave the grams blank if you don't know them; the food is then logged in servings.</li>
      <li>Choose whether the numbers are per serving or per 100 g, fill in calories, protein, carbs, fat and fiber, and tap <strong>Save food</strong>.</li>
    </ol>
    <p>Your foods are listed under <strong>My foods</strong>.</p>
    <h3>Fix a food</h3>
    <p>Open the food and tap <strong>Edit food</strong>. Your corrected copy keeps the barcode, so later scans and searches find your numbers. It shows "Edited by you". If you logged the same food elsewhere that day, the app offers to update those entries too; other days keep their old numbers.</p>
    <p>Watch for <strong>These numbers look off</strong> on a food. It means the values are missing, impossible, or the calories don't match the macros. Check the label and edit the food.</p>
    <h3>Read a label with AI</h3>
    ${label}`;
}

function weightBody() {
  const u = wUnit();
  return `
    <p>Your scale weight can swing by a ${u === 'kg' ? 'kilo or so' : 'pound or two'} from day to day with water and food. MacroTally smooths your weigh-ins into a trend line. The trend weight is what to watch.</p>
    <h3>Log a weigh-in</h3>
    <ul>
      <li>On the <strong>Diary</strong>, use <strong>Log today's weight</strong> (it shows until you have weighed in that day).</li>
      <li>Or on the <strong>Weight</strong> tab, fill in <strong>Log weight</strong> (you can pick an earlier date) and tap <strong>Save weight</strong>.</li>
    </ul>
    <p>Weigh in most mornings, after the bathroom and before eating. Logging a date again replaces that day's weight. Delete one with the bin icon under <strong>Recent entries</strong>.</p>
    <h3>Reading the Weight tab</h3>
    <p>The top shows your trend weight, your last scale weight and the trend's change over 7 and 30 days, and, if you set a target weight, your progress to it. In the chart, the dots are your scale weights and the line is the trend. Switch the range between 30, 90 and 180 days, or all.</p>
    <h3>Smart scales</h3>
    <p>If your scale sends its readings to Apple Health, an iPhone Shortcut can copy them to a secret GitHub gist once a day, and MacroTally picks them up when you open it. Paste the gist id in <strong>Settings</strong> → <strong>Weight feed</strong> and tap <strong>Save weight feed</strong>; <strong>Sync now</strong> fetches at once. Weigh-ins you type are never overwritten. The one-time setup is in the ${readmeLink('README')}.</p>`;
}

function planBody() {
  const u = wUnit();
  return `
    <p>The <strong>Plan</strong> tab shows your expenditure (calories you burn), daily targets, calorie bank and goal.</p>
    <h3>Goal and rate</h3>
    <p>Tap <strong>Update goal</strong> to choose lose, maintain or gain, a target weight and a rate per week in ${u}. The buttons 0.25%, 0.5%, 0.75% and 1% fill in that share of your bodyweight per week. You can also set protein (grams per ${u}), fat (% of calories) or manual macro targets. Tap <strong>Save goal</strong>.</p>
    <p>Your calorie target is your expenditure minus (or plus) what your rate needs each day; carbs fill the rest. With a target weight set, <strong>Daily targets</strong> shows roughly when you will reach it.</p>
    <h3>Adaptive expenditure</h3>
    <p>At first, expenditure is a formula estimate ("Initial estimate"). Once you have at least 7 logged days and two weigh-ins at least 7 days apart, all within the last 3 weeks, it switches to "Adaptive": worked out from what you ate and how your trend weight moved. It then updates once a week, and your target follows. <strong>Recalculate now</strong> updates it right away.</p>
    <p>Log a day completely or not at all. Unlogged days are ignored, but half-logged days drag the estimate down.</p>
    <h3>The calorie bank</h3>
    <p>Tick <strong>Keep a calorie bank</strong> to carry calories between days. Each finished day adds your target minus what you ate (under saves calories, over takes them off), counted the next day. A day with nothing logged resets it to zero. Your targets never change; the balance shows on the Diary, to spend or make up when you choose. <strong>Reset bank</strong> starts again from today.</p>`;
}

function dataBody() {
  const drive = driveConfigured()
    ? `<p>In <strong>Settings</strong> → <strong>Google Drive backup</strong>, tap <strong>Connect Google Drive</strong>. Your data is copied to a private app folder in your own Google Drive about once a day when you open the app. <strong>Back up now</strong> and <strong>Restore from Drive</strong> are there too.</p>`
    : `<p>Daily backup to your own Google Drive is available only when the person hosting the app has set it up; it is not set up in this copy. See the ${readmeLink('README')}.</p>`;
  return `
    <p>Your diary, weights and goals are stored only in this browser on this phone. There is no account.</p>
    <h3>Backups</h3>
    <p>In <strong>Settings</strong> → <strong>Backup</strong>, <strong>Export backup</strong> saves everything to a file. <strong>Import backup</strong> replaces everything on this phone with a file. Export now and then, and before switching phones.</p>
    ${drive}
    <h3>Where food data comes from</h3>
    <ul>
      <li>A built-in list of generic foods, searched instantly, even offline.</li>
      <li>Open Food Facts, always on, for barcodes and search. It allows about 10 searches a minute, so the app waits for you to stop typing.</li>
      <li>USDA FoodData Central, with a shared key built in. Add your own free key in <strong>Settings</strong> → <strong>Food sources</strong> to avoid its hourly limit.</li>
    </ul>
    <p>Set your <strong>Search region</strong> there too, so results favour foods sold in your country.</p>
    <h3>Restaurant food packs</h3>
    <p>Packs are restaurant menus, logged per item; search like "taco bell burrito". In <strong>Settings</strong> → <strong>Food packs</strong>, switch off chains you never visit, or use <strong>Import food pack</strong> to add one from a file.</p>
    <h3>Updates</h3>
    <p>Updates install themselves: close the app fully and reopen it. When a new version is ready, the Diary shows <strong>New version ready · Tap to reload</strong>. <strong>Check for updates</strong> is under <strong>About</strong> at the bottom of Settings.</p>`;
}

/** Help topics in Settings order: id, row title, row subtitle and the sheet body. */
export const HELP_TOPICS = [
  { id: 'start', title: 'Getting started', sub: 'Setup, installing, the first week', body: startBody },
  { id: 'logging', title: 'Logging food', sub: 'Meals, search, amounts, editing entries', body: loggingBody },
  { id: 'scanning', title: 'Scanning barcodes', sub: 'Camera, manual entry, foods not found', body: scanningBody },
  { id: 'ai', title: 'AI add', sub: 'Describe or photograph food, recipes', body: aiBody },
  { id: 'fixing', title: 'Custom foods and fixing numbers', sub: 'Create, edit any food, label photos', body: fixingBody },
  { id: 'weight', title: 'Weight', sub: 'Weigh-ins, the trend line, smart scales', body: weightBody },
  { id: 'plan', title: 'Goal, targets and expenditure', sub: 'Rates, adaptive calories, the calorie bank', body: planBody },
  { id: 'data', title: 'Backups, sync and food data', sub: 'Export, Google Drive, sources, packs, updates', body: dataBody }
];

/**
 * Open one help topic in a bottom sheet.
 * @param {string} id topic id from HELP_TOPICS
 * @returns {HTMLElement|null} backdrop
 */
export function openHelp(id) {
  const t = HELP_TOPICS.find((x) => x.id === id);
  if (!t) return null;
  return openModal(`${sheetHead(t.title)}<div class="help-body">${t.body()}</div>`, { cls: 'setting-sheet help-sheet' });
}

on('open-help', (el) => openHelp(el.dataset.topic));
