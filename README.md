# MacroTally

A free, account-less macro tracker you host yourself and run on your phone. It replaces the parts of MacroFactor that matter most:

- **Barcode scanning** with the phone camera, looked up in the free Open Food Facts database (optionally USDA FoodData Central too).
- **Portion scaling by weight**: log in grams, ounces or servings and watch the macros scale live.
- **Macro tracking** per meal against daily calorie, protein, carb and fat targets.
- **Goal setting**: lose, maintain or gain at a chosen rate per week, with protein and fat preferences, and an estimated finish date.
- **Trend weight**: daily weigh-ins smoothed into a trend line so water-weight noise does not hide progress.
- **Adaptive expenditure**: your maintenance calories are estimated weekly from what you actually ate versus how your trend weight moved, and your calorie target follows it. This is the MacroFactor "algorithm", done in the open.
- **Backup / restore** as a JSON file. Installable as a home-screen app that works offline for everything except new food lookups.

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

## Layout

```
index.html            app shell
css/app.css           styles, light and dark
js/store.js           state and localStorage persistence
js/calc.js            trend weight, expenditure, targets
js/foods.js           Open Food Facts / USDA lookup, portion scaling
js/scanner.js         camera barcode scanning
js/charts.js          inline SVG charts
js/ui.js, js/app.js   rendering, routing, modals
js/views/*.js         Diary, Weight, Plan, Settings screens
js/modals/*.js        add food, food detail, custom food, scanner, setup wizard
sw.js                 service worker (offline app shell)
tools/                icon generator and unit tests (`node tools/test_calc.mjs`)
```

See `SPEC.md` for the full design and the algorithms.
