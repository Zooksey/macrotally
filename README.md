# MacroTally

A free, account-less macro tracker you host yourself and run on your phone. It replaces the parts of MacroFactor that matter most:

- **Barcode scanning** with the phone camera, looked up in the free Open Food Facts database (optionally USDA FoodData Central too).
- **Portion scaling by weight**: log in grams, ounces or servings and watch the macros scale live.
- **Macro tracking** per meal against daily calorie, protein, carb and fat targets.
- **Goal setting**: lose, maintain or gain at a chosen rate per week, with protein and fat preferences, and an estimated finish date.
- **Trend weight**: daily weigh-ins smoothed into a trend line so water-weight noise does not hide progress.
- **Adaptive expenditure**: your maintenance calories are estimated weekly from what you actually ate versus how your trend weight moved, and your calorie target follows it. This is the MacroFactor "algorithm", done in the open.
- **Backup / restore** as a JSON file, plus an optional automatic daily backup to each user's own Google Drive. Installable as a home-screen app that works offline for everything except new food lookups.

There is no server, no login and no analytics. Everyone who opens the link gets their own copy; their diary, weights and goals are stored only in their own browser on their own phone.

## Hosting it for free (GitHub Pages)

The app is plain static files, so any static host works. GitHub Pages is free and gives you the HTTPS address the camera requires.

1. Create a GitHub account if needed, then create a new **public** repository, for example `macrotally`.
2. Push this folder to it:

   ```bash
   git init
   git add .
   git commit -m "MacroTally"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/macrotally.git
   git push -u origin main
   ```

3. In the repository on GitHub go to **Settings → Pages**, set **Source** to "Deploy from a branch", pick branch `main` and folder `/ (root)`, and save.
4. After a minute the app is live at `https://YOUR-USER.github.io/macrotally/`. Share that link with anyone.

Netlify Drop or Cloudflare Pages work the same way if you prefer: drag the folder in and you get an HTTPS link.

### Updating

Push new commits. Bump the `VERSION` string at the top of `sw.js` whenever you change files so installed phones pick up the new version on their next open.

## Installing on a phone

- **iPhone**: open the link in Safari, tap Share, then **Add to Home Screen**. Open it from the home screen icon. This matters: iOS can wipe the storage of a web page that is not on the home screen and goes unused for a week.
- **Android**: open the link in Chrome, tap the **Install** prompt (or menu → Add to Home screen).

The camera needs a secure address (`https://` or `localhost`), so scanning will not work if you open the files directly or over plain `http://` on your LAN.

## Using it

1. First open: the setup wizard asks for units, sex, age, height, current weight, activity and your goal. It sets an initial calorie estimate from the Mifflin-St Jeor formula.
2. Log everything you eat. Tap **Add food** on a meal, then scan a barcode or search by name. Pick an amount in grams, ounces or servings.
3. Weigh yourself most mornings and log it on the **Weight** tab. The trend line is what to watch.
4. After about a week of complete logging and weigh-ins, the **Plan** tab switches the expenditure estimate from the formula to the adaptive one, and your calorie target updates every week. Tap **Recalculate now** any time.

Two rules make the adaptive estimate accurate: log a day completely or not at all (unlogged days are ignored, half-logged days drag the estimate down), and weigh in often.

## Running locally

Any static server works, for example:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/`. `localhost` counts as secure, so the camera works there too.

## Food data

- [Open Food Facts](https://world.openfoodfacts.org) is always on and needs no key. Coverage of packaged foods is good but not perfect, and some entries have incomplete nutrition. If a scan is not found you can create the food once and it is remembered by barcode. Text search is limited by Open Food Facts to roughly 10 searches a minute per phone, so the app waits for you to stop typing before searching and remembers results you already fetched. Set your **Search region** in Settings so results are ranked by what is popular in your country.
- [USDA FoodData Central](https://fdc.nal.usda.gov/) adds whole foods and US branded items. Get a free API key at https://fdc.nal.usda.gov/api-key-signup and paste it into Settings.

## Built-in food list

`data/foods.json` is a list of about 2,600 generic foods (USDA FoodData Central Foundation and SR Legacy, public domain) that ships with the app and is searched instantly, even offline. It is generated and committed; you only need to rebuild it to refresh the data. With a free USDA API key, run from the project root (no npm needed, Node 18+):

```sh
USDA_API_KEY=... node tools/build_foods.mjs
```

PowerShell: `$env:USDA_API_KEY='...'; node tools/build_foods.mjs`. Add `--dry` to see the filtered counts without writing anything. A full build makes about 200 API requests (well under the key's 1,000 per hour) and takes about 15 minutes. The output is kept under 400 KB by dropping the most specific SR Legacy variants first.

## Restaurant food packs

A food pack is a restaurant menu as a JSON file. Its items are searched instantly alongside the built-in list, work offline and are logged per serving ("1 burrito"), since chains publish nutrition per item rather than per 100 g. Searching for the chain name finds them too, for example "taco bell burrito". The app ships with packs for Taco Bell, Applebee's, Arby's, Buffalo Wild Wings, Burger King, Chick-fil-A, Chili's, Chipotle, Cracker Barrel, Culver's, Dairy Queen, Domino's, Dunkin', Five Guys, IHOP, In-N-Out, Jack in the Box, Jersey Mike's, Jimmy John's, KFC, Little Caesars, McDonald's, Olive Garden, Panda Express, Panera Bread, Papa John's, Pizza Hut, Popeyes, Raising Cane's, Shake Shack, Sonic, Starbucks, Subway, Texas Roadhouse, Wendy's, Whataburger, Wingstop and Zaxby's (in `data/packs/`); the built-in packs are the files listed in `data/packs/index.json`.

### Building a pack

Pack files are generated from the free public menu tables on [Nutritionix](https://www.nutritionix.com/), which many chains use for their own nutrition pages. To find a chain's slug, search for the chain on nutritionix.com and open its menu; the slug is the part of the address after the domain, e.g. `taco-bell` in `https://www.nutritionix.com/taco-bell/menu/premium`. Then run from the project root (no npm needed, Node 18+):

```sh
node tools/build_pack.mjs --nutritionix taco-bell --name "Taco Bell" --skip "Cantina Beer, Wine and Spirits"
```

(That is how the bundled Taco Bell pack is built: the 200 beers and wines of the Cantina locations would otherwise crowd the search results.)

The bundled Starbucks pack keeps only the 2% milk and no-milk drinks in Tall, Grande and Venti (the "Skinny" and "Light" drinks, which are made with nonfat milk, stay), because every drink is listed once per size and milk and the full menu is 3,600 items:

```sh
node tools/build_pack.mjs --nutritionix starbucks --name "Starbucks" --drop '\b(whole|soy|coconut|almond|oat)\s*milk\b|\boatmilk\b' --drop '^(?!.*\b(skinny|light)\b).*\bnonfat milk\b' --drop ',\s*(short|kids?|trenta)$'
```

This writes `data/packs/<slug>.json`. Options: `--brand "..."` (defaults to the name; it is shown on every item and is searchable), `--out <file>` to write somewhere else, `--skip "Section A,Section B"` to leave whole menu sections out (exact section names as shown on the page, any letter case, separated by commas; a name that itself contains commas can be written as is, and the skipped names are recorded in the pack as `skipped`), `--drop "<regex>"` to leave out items whose name matches a JavaScript regular expression (any letter case; can be given more than once, and the expressions are recorded in the pack as `dropped`), `--dry` to print the item counts per menu section and the first 10 items without writing anything, and `--from <file.html>` to parse a copy of the menu page saved from your browser instead of downloading it (useful if the site refuses the request). Each item gets a serving label guessed from its name and section ("1 taco", "1 order", "1 drink (20 oz)", otherwise "1 serving").

To ship a new pack with the app, add its file name to `data/packs/index.json` and to the `SHELL` list in `sw.js`, then bump `VERSION`.

### Importing a personal pack

You do not have to host a pack to use it: in **Settings → Food packs**, tap **Import food pack** and pick the JSON file. Imported packs are stored on that phone only and are included in backups. Importing a pack with the same `id` again replaces it (and overrides a built-in pack with that `id`); **Remove** deletes it.

### Pack format

```json
{
  "format": "macrotally-pack/1",
  "id": "taco-bell",
  "name": "Taco Bell",
  "brand": "Taco Bell",
  "source": "https://www.nutritionix.com/taco-bell/menu/premium",
  "generated": "2026-10-28",
  "foods": [
    { "id": "166727", "n": "Burrito Supreme - Beef", "cat": "Burritos", "s": ["1 burrito", null], "v": [390, 16, 52, 14, 8] }
  ]
}
```

- `format` must be exactly `macrotally-pack/1`. `id` is a short lowercase name (`a-z`, `0-9`, `-`), `name` is shown in Settings and `brand` is attached to every item. `source`, `generated` and the optional `skipped` (menu sections left out by `--skip`) are for information only.
- Each food has an `id` that is unique within the pack, a name `n`, an optional menu section `cat`, a serving `s` = `[label, grams]` and the nutrients `v` = `[kcal, protein g, carbs g, fat g, fiber g]` for one serving.
- Use `null` for the grams when the serving weight is unknown (the usual case for restaurants); the item is then logged by the serving only. With a weight, the item can also be logged in grams or ounces.
- Items with a missing `id` or name, or without at least four non-negative numbers in `v`, are skipped. A file with no valid items is rejected.

## Google Drive backup (optional, for the app owner)

Each person who uses your link can connect their own Google account, and MacroTally will keep a copy of their data in a hidden, app-only folder of *their* Google Drive. It refreshes the copy about once a day when they open the app, and Settings has **Back up now** and **Restore from Drive** buttons. There is still no server: the phone talks to Google directly.

The feature stays hidden until you, the person hosting the app, create a free Google "OAuth client ID" and paste it into `js/config.js`. You only do this once. If you have never used Google Cloud before, follow these steps exactly:

1. Go to https://console.cloud.google.com/ and sign in with your Google account. Click the project picker at the top, then **New project**, name it (e.g. "MacroTally") and click **Create**. Make sure the new project is selected in the picker.
2. Open the menu (☰) → **APIs & Services** → **Library**. Search for **Google Drive API**, open it and click **Enable**.
3. Menu → **APIs & Services** → **OAuth consent screen** (newer consoles call this **Google Auth Platform**; click **Get started** if asked).
   - User type / Audience: **External**.
   - App name: "MacroTally". User support email and developer contact email: your email.
   - Under **Scopes** (or **Data access**) click **Add or remove scopes** and add `.../auth/drive.appdata` and `.../auth/userinfo.email`, then save.
   - Then go to **Audience** (or **Publishing status**) and click **Publish app**. These two scopes are non-sensitive, so Google does not require a review. While the app is left in "Testing", only the test users you list there can sign in.
4. Menu → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: add `https://YOUR-USER.github.io` (your GitHub Pages address, without the `/macrotally/` path) and `http://localhost:8765` (for local testing).
   - No redirect URIs are needed. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
5. Paste the client ID into `js/config.js`:

   ```js
   googleClientId: '1234567890-abc123.apps.googleusercontent.com'
   ```

   Then bump `VERSION` in `sw.js`, commit and push.

To try it locally, serve the folder on the port you authorized: `python -m http.server 8765`, then open `http://localhost:8765/`.

Good to know:

- The client ID is not a secret; it is fine for it to be in a public repository.
- Each user's backup goes to their own Google Drive, in a hidden app folder that only MacroTally can read. You, the owner, never see anyone's data, and nothing touches your own Drive.
- Disconnecting in Settings does not delete the backup file. Users can remove it under Google Drive → Settings (gear) → **Manage apps** → MacroTally → **Delete hidden app data**.

## Layout

```
index.html            app shell
css/app.css           styles, light and dark
js/config.js          app owner settings (Google client ID for Drive backup)
js/store.js           state and localStorage persistence
js/calc.js            trend weight, expenditure, targets
js/foods.js           Open Food Facts / USDA lookup, portion scaling
js/scanner.js         camera barcode scanning
js/charts.js          inline SVG charts
js/drive.js           optional Google Drive backup (Google sign-in + Drive API)
js/ui.js, js/app.js   rendering, routing, modals
js/views/*.js         Diary, Weight, Plan, Settings screens
js/modals/*.js        add food, food detail, custom food, scanner, setup wizard
sw.js                 service worker (offline app shell)
tools/                icon generator and unit tests (`node tools/test_calc.mjs`)
```

See `SPEC.md` for the full design and the algorithms.
